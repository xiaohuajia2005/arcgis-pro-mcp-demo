#!/usr/bin/env node
/**
 * ArcGIS Pro MCP Server
 *
 * 架构说明：
 *   Node (此文件) 负责 MCP 协议，因为 ArcGIS Pro 自带的 Python 是 3.9，
 *   装不了任何版本的 mcp SDK。真正的 arcpy 操作通过常驻子进程
 *   arcpy_worker.py 完成（用它自带的 arcgispro-py3 解释器）。
 *
 * 重要：MCP 的 stdio 传输要求 stdout 只能输出协议数据，
 *       所有日志一律走 stderr。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 定位 ArcGIS Pro 自带的 Python 解释器。
 *
 * 为什么必须用它、不能用系统 Python：
 *   只有 arcgispro-py3 这个环境里装了 arcpy 和有效的许可绑定，
 *   用别的解释器执行 import arcpy 会直接失败。
 *
 * 查找顺序：环境变量 > 常见安装位置。Pro 默认装在
 * C:\Program Files\ArcGIS\Pro，也允许装在其它盘符。
 */
const PY_CANDIDATES = [
  process.env.ARCGIS_PRO_PYTHON,
  "C:\\Program Files\\ArcGIS\\Pro\\bin\\Python\\envs\\arcgispro-py3\\python.exe",
  "D:\\ArcGIS\\bin\\Python\\envs\\arcgispro-py3\\python.exe",
  "D:\\Program Files\\ArcGIS\\Pro\\bin\\Python\\envs\\arcgispro-py3\\python.exe",
  "E:\\ArcGIS\\bin\\Python\\envs\\arcgispro-py3\\python.exe",
].filter(Boolean);

// 优先用实际存在的路径；都没有时，若用户显式设了环境变量就照它报错（更利于排查）
const PRO_PYTHON =
  PY_CANDIDATES.find((p) => existsSync(p)) ||
  process.env.ARCGIS_PRO_PYTHON ||
  PY_CANDIDATES[1];
const WORKER = path.join(__dirname, "arcpy_worker.py");
const STATE_FILE = path.join(__dirname, "state.json");

const log = (...a) => console.error("[arcgis-pro-mcp]", ...a);

// 环境变量设了但路径无效时不静默回退，打一条警告便于排查
if (process.env.ARCGIS_PRO_PYTHON && !existsSync(process.env.ARCGIS_PRO_PYTHON)) {
  log("警告：ARCGIS_PRO_PYTHON 指向的路径不存在 ->", process.env.ARCGIS_PRO_PYTHON);
  log("      已自动改用探测结果 ->", PRO_PYTHON);
}

/* ------------------------------------------------------------------ */
/* 常驻 arcpy worker 管理                                              */
/* ------------------------------------------------------------------ */
let child = null;
let seq = 0;
let ready = false;
let startError = null;
const pending = new Map();
const waiters = [];

/** 唤醒所有等待 worker 就绪的调用方：传 err 表示启动失败/进程退出 */
function flushWaiters(err) {
  const list = waiters.splice(0);
  for (const w of list) {
    clearTimeout(w.timer);
    if (err) w.reject(err);
    else w.resolve();
  }
}

function startWorker() {
  if (child) return;
  if (!existsSync(PRO_PYTHON)) {
    startError =
      `找不到 ArcGIS Pro 的 Python 解释器：${PRO_PYTHON}\n` +
      "请确认已安装 ArcGIS Pro，或设置环境变量 ARCGIS_PRO_PYTHON 指向 " +
      "arcgispro-py3\\python.exe";
    log(startError);
    return;
  }
  startError = null;
  child = spawn(PRO_PYTHON, [WORKER], {
    cwd: __dirname,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let idx;
    // worker 每行一个 JSON，按行切分后逐条处理
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        log("无法解析 worker 输出:", line.slice(0, 300));
        continue;
      }
      // 启动握手：worker 加载完 arcpy 后回报一次 ready
      if (msg.ready !== undefined) {
        ready = !!msg.ready;
        log("worker 就绪:", JSON.stringify(msg));
        if (ready) flushWaiters();
        continue;
      }
      const p = pending.get(msg.id);
      if (!p) continue;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg);
      else p.reject(msg);
    }
  });

  // worker 的日志走 stderr，不污染协议通道
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => {
    const t = String(d).trim();
    if (t) log("worker:", t.slice(0, 800));
  });

  child.on("exit", (code) => {
    log("worker 退出, code =", code);
    child = null;
    ready = false;
    // 正在执行的请求全部失败快速返回，避免调用方一直挂着
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject({ error: "arcpy worker 已退出，请重试" });
    }
    pending.clear();
    flushWaiters(new Error("arcpy worker 启动后立即退出，请检查 ArcGIS Pro 是否已授权"));
  });
}

function waitReady() {
  if (ready) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("arcpy worker 启动超时（120 秒）"));
    }, 120000);
    waiters.push({ resolve, reject, timer });
    startWorker();
    // 找不到解释器这类错误不必等超时，立刻抛给调用方
    if (startError) flushWaiters(new Error(startError));
  });
}

async function callWorker(action, params = {}, timeoutMs = 1800000) {
  await waitReady();
  return new Promise((resolve, reject) => {
    const id = String(++seq);
    const timer = setTimeout(() => {
      pending.delete(id);
      reject({ error: `arcpy 执行超时：${action}` });
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, action, params }) + "\n");
  });
}

/* 记住上次打开的工程，server 重启后自动恢复 */
function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}
function saveState(s) {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), "utf8");
  } catch {}
}

/* ------------------------------------------------------------------ */
/* MCP Server                                                          */
/* ------------------------------------------------------------------ */
const server = new McpServer({
  name: "arcgis-pro",
  version: "1.0.0",
});

/** 统一把 worker 结果包成 MCP 响应 */
async function run(action, params = {}) {
  try {
    const r = await callWorker(action, params);
    let text;
    if (typeof r.data === "string") text = r.data;
    else text = JSON.stringify(r.data, null, 2);
    return { content: [{ type: "text", text }] };
  } catch (e) {
    const msg = e && e.error ? e.error : String(e);
    return {
      isError: true,
      content: [{ type: "text", text: `操作失败：${msg}` }],
    };
  }
}

const APRK_DESC = "ArcGIS Pro 工程文件（.aprx）的完整路径，如 D:\\\\data\\\\my.aprx";
const MAP_DESC = "地图名称，可先用 pro_list_layers 查看；不传则使用工程的活动地图";

server.registerTool(
  "pro_ping",
  {
    title: "检查 ArcGIS Pro 环境",
    description:
      "检查 ArcGIS Pro 的 arcpy 是否可用，返回 arcpy 版本、许可级别（Basic/Standard/Advanced）和 Python 版本。接入排查时先调用它。",
    inputSchema: {},
  },
  async () => run("ping")
);

server.registerTool(
  "pro_open_project",
  {
    title: "打开 ArcGIS Pro 工程",
    description:
      "打开一个 .aprx 工程并设为后续操作的当前工程，返回工程内的地图、布局列表和默认地理数据库。几乎所有其他工具都需要先调用它。",
    inputSchema: {
      aprx_path: z.string().describe(APRK_DESC),
    },
  },
  async ({ aprx_path }) => {
    const r = await run("open_project", { aprx_path });
    if (!r.isError) saveState({ aprx: aprx_path });
    return r;
  }
);

server.registerTool(
  "pro_project_info",
  {
    title: "工程概况",
    description:
      "查看当前工程的路径、默认地理数据库、所有地图（含图层数、坐标系）与布局。快速了解工程结构时用。",
    inputSchema: {},
  },
  async () => run("project_info")
);

server.registerTool(
  "pro_list_maps",
  {
    title: "列出地图",
    description: "列出当前工程中的所有地图名称。",
    inputSchema: {},
  },
  async () => run("list_maps")
);

server.registerTool(
  "pro_list_layers",
  {
    title: "列出图层",
    description:
      "列出地图中的所有图层，包含图层名、是否可见、要素/栅格类型、几何类型和数据源路径。这是获取图层名的第一步。",
    inputSchema: {
      map_name: z.string().optional().describe(MAP_DESC),
    },
  },
  async ({ map_name }) => run("list_layers", { map_name })
);

server.registerTool(
  "pro_describe",
  {
    title: "描述数据集",
    description:
      "查看要素类/栅格/图层的详细信息：数据类型、坐标系、范围、字段列表、要素数量。做分析前确认数据情况用。",
    inputSchema: {
      dataset: z.string().describe("图层名或数据集完整路径"),
      map_name: z.string().optional().describe(MAP_DESC),
    },
  },
  async ({ dataset, map_name }) => run("describe", { dataset, map_name })
);

server.registerTool(
  "pro_list_fields",
  {
    title: "查看字段",
    description: "列出数据集的全部字段，含字段名、别名、类型、长度。",
    inputSchema: {
      dataset: z.string().describe("图层名或数据集完整路径"),
      map_name: z.string().optional().describe(MAP_DESC),
    },
  },
  async ({ dataset, map_name }) => run("list_fields", { dataset, map_name })
);

server.registerTool(
  "pro_query_attributes",
  {
    title: "查询属性",
    description:
      "读取要素属性表。可用 SQL 表达式筛选（如 \"面积 > 1000\"），返回指定字段的前若干行记录。",
    inputSchema: {
      dataset: z.string().describe("图层名或数据集完整路径"),
      fields: z
        .array(z.string())
        .optional()
        .describe("要返回的字段名列表，不填则自动取前 15 个非几何字段"),
      where: z.string().optional().describe('SQL 查询条件，如 "POP > 100000"'),
      limit: z.number().int().positive().optional().describe("返回行数上限，默认 20"),
      map_name: z.string().optional().describe(MAP_DESC),
    },
  },
  async ({ dataset, fields, where, limit, map_name }) =>
    run("query_attributes", { dataset, fields, where, limit, map_name })
);

server.registerTool(
  "pro_run_geoprocessing",
  {
    title: "运行任意地理处理工具",
    description:
      "调用 ArcGIS 任意地理处理工具（万能入口）。tool 用 ArcPy 的模块.工具 写法，如 analysis.Buffer、analysis.Clip、management.Project、conversion.FeatureToRaster。parameters 按 ArcPy 函数参数顺序传入。不确定工具名时优先用这个而不是写代码。",
    inputSchema: {
      tool: z
        .string()
        .describe("工具调用路径，如 analysis.Buffer 或 management.Project"),
      parameters: z
        .array(z.any())
        .describe(
          '按顺序传参的数组，如 ["in_layer", "out_fc", "500 Meters"]；字符串参数可直接用图层名'
        ),
    },
  },
  async ({ tool, parameters }) => run("run_geoprocessing", { tool, parameters })
);

server.registerTool(
  "pro_buffer",
  {
    title: "缓冲区分析",
    description:
      "对图层做缓冲区。distance 需带单位，如 \"500 Meters\"、\"1 Kilometers\"。输出名可只给名称，会自动输出到工程默认地理数据库。",
    inputSchema: {
      layer: z.string().describe("输入图层名或数据路径"),
      distance: z.string().describe('缓冲距离，如 "500 Meters"'),
      out: z.string().optional().describe("输出要素类名称或完整路径"),
      dissolve: z
        .string()
        .optional()
        .describe('融合选项：NONE / ALL / LIST，默认 NONE'),
      map_name: z.string().optional().describe(MAP_DESC),
    },
  },
  async ({ layer, distance, out, dissolve, map_name }) =>
    run("buffer", { layer, distance, out, dissolve, map_name })
);

server.registerTool(
  "pro_clip",
  {
    title: "裁剪",
    description: "用裁剪要素的范围裁剪输入要素。",
    inputSchema: {
      in_features: z.string().describe("被裁剪的图层名或路径"),
      clip_features: z.string().describe("作为裁剪边界的图层名或路径"),
      out: z.string().optional().describe("输出要素类名称或完整路径"),
      map_name: z.string().optional().describe(MAP_DESC),
    },
  },
  async ({ in_features, clip_features, out, map_name }) =>
    run("clip", { in_features, clip_features, out, map_name })
);

server.registerTool(
  "pro_project_data",
  {
    title: "投影转换",
    description:
      "把数据转换到目标坐标系。目标可用 epsg（如 4490、32650）或 wkt 指定。",
    inputSchema: {
      in_dataset: z.string().describe("输入图层名或数据路径"),
      out: z.string().optional().describe("输出要素类名称或完整路径"),
      epsg: z.union([z.string(), z.number()]).optional().describe("目标坐标系 EPSG 代码，如 4490"),
      wkt: z.string().optional().describe("目标坐标系 WKT 字符串（与 epsg 二选一）"),
      map_name: z.string().optional().describe(MAP_DESC),
    },
  },
  async ({ in_dataset, out, epsg, wkt, map_name }) =>
    run("project_data", { in_dataset, out, epsg, wkt, map_name })
);

server.registerTool(
  "pro_export_map",
  {
    title: "导出地图",
    description:
      "把地图导出为图片或 PDF。输出扩展名决定格式：.png / .jpg / .pdf。",
    inputSchema: {
      out: z.string().describe("输出文件完整路径，如 D:\\\\out\\\\map.png"),
      map_name: z.string().optional().describe(MAP_DESC),
      dpi: z.number().int().positive().optional().describe("分辨率，默认 150"),
    },
  },
  async ({ out, map_name, dpi }) => run("export_map", { out, map_name, dpi })
);

server.registerTool(
  "pro_export_layout",
  {
    title: "导出布局",
    description: "把制图布局导出为图片或 PDF。",
    inputSchema: {
      out: z.string().describe("输出文件完整路径"),
      layout_name: z.string().optional().describe("布局名称，不传则用第一个布局"),
      dpi: z.number().int().positive().optional().describe("分辨率，默认 150"),
    },
  },
  async ({ out, layout_name, dpi }) =>
    run("export_layout", { out, layout_name, dpi })
);

server.registerTool(
  "pro_save_project",
  {
    title: "保存工程",
    description:
      "保存当前工程到 .aprx 文件。注意：外部修改后需在 ArcGIS Pro 中重新加载工程才能看到变化。",
    inputSchema: {},
  },
  async () => run("save_project")
);

server.registerTool(
  "pro_run_python",
  {
    title: "执行 arcpy 代码",
    description:
      "执行任意 arcpy 代码片段，用于上面工具覆盖不到的高级操作。代码中可直接使用 arcpy 和 project 变量，把结果赋给 result 变量即可返回。",
    inputSchema: {
      code: z
        .string()
        .describe(
          'Python 代码，如 "result = [l.name for l in project.activeMap.listLayers()]"'
        ),
    },
  },
  async ({ code }) => run("run_python", { code })
);

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */
async function main() {
  startWorker();

  // 后台预热 + 恢复上次的工程，不阻塞 MCP 握手
  waitReady()
    .then(async () => {
      const st = loadState();
      if (st.aprx && existsSync(st.aprx)) {
        try {
          await callWorker("open_project", { aprx_path: st.aprx });
          log("已自动恢复工程:", st.aprx);
        } catch (e) {
          log("恢复工程失败:", e && e.error);
        }
      }
    })
    .catch((e) => log("worker 预热失败:", e && e.error));

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("MCP server 已启动");
}

main().catch((e) => {
  log("致命错误:", e);
  process.exit(1);
});
