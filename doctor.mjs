/**
 * ArcGIS Pro MCP 自检脚本
 *
 * 用途：当 MCP 客户端里「看不到工具」或「工具调用一直失败」时，先跑这个，
 *       它会按层次逐项检查，直接告诉你断在哪一层。
 *
 * 用法：node doctor.mjs
 *
 * 检查顺序：
 *   1. Node 与 ArcGIS Pro Python 是否就位
 *   2. MCP 握手是否成功
 *   3. 工具是否全部注册
 *   4. arcpy 是否真的能加载（含许可）
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, "server.mjs");
const EXPECTED_TOOLS = 16;

// 与 server.mjs 保持一致的 Python 查找逻辑
const PY_CANDIDATES = [
  process.env.ARCGIS_PRO_PYTHON,
  "C:\\Program Files\\ArcGIS\\Pro\\bin\\Python\\envs\\arcgispro-py3\\python.exe",
  "D:\\ArcGIS\\bin\\Python\\envs\\arcgispro-py3\\python.exe",
  "D:\\Program Files\\ArcGIS\\Pro\\bin\\Python\\envs\\arcgispro-py3\\python.exe",
  "E:\\ArcGIS\\bin\\Python\\envs\\arcgispro-py3\\python.exe",
].filter(Boolean);
const PY = PY_CANDIDATES.find((p) => existsSync(p));

let bad = 0;
const ok = (m) => console.log("  [OK]   " + m);
const fail = (m) => {
  bad++;
  console.log("  [FAIL] " + m);
};

console.log("1. 检查运行环境");
ok(`Node ${process.version}`);
if (PY) ok("ArcGIS Pro Python: " + PY);
else {
  fail("找不到 ArcGIS Pro 的 Python，尝试过：");
  for (const p of PY_CANDIDATES) console.log("         - " + p);
  console.log("         解决：设置环境变量 ARCGIS_PRO_PYTHON 指向 arcgispro-py3\\python.exe");
}
existsSync(SERVER) ? ok("server.mjs 存在") : fail("server.mjs 缺失");

if (!PY) {
  console.log("\n环境不完整，后续检查无法进行。");
  process.exit(1);
}

console.log("\n2. 启动 MCP 服务并握手");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [SERVER],
  stderr: "inherit", // worker 的日志直接打出来，便于排查
  env: { ...process.env, ARCGIS_PRO_PYTHON: PY },
});
const client = new Client({ name: "doctor", version: "1.0.0" });

try {
  await client.connect(transport);
  ok("MCP 握手成功");

  console.log("\n3. 检查工具注册");
  const tools = await client.listTools();
  const n = tools.tools.length;
  n === EXPECTED_TOOLS
    ? ok(`工具数量 ${n}`)
    : fail(`工具数量异常：${n}（预期 ${EXPECTED_TOOLS}）`);
  if (n !== EXPECTED_TOOLS) {
    console.log("         已注册：" + tools.tools.map((t) => t.name).join(", "));
  }

  console.log("\n4. 检查 arcpy 是否可用");
  const r = await client.callTool({ name: "pro_ping", arguments: {} });
  const text = r.content.map((c) => c.text).join("");
  if (r.isError) fail("pro_ping 失败: " + text);
  else ok("arcpy 可用 " + text.replace(/\s+/g, " ").slice(0, 100));
} catch (e) {
  fail("连接失败: " + (e && e.message ? e.message : String(e)));
}

await client.close().catch(() => {});
console.log(
  bad === 0
    ? "\n全部通过，服务可用。"
    : `\n有 ${bad} 项失败，请按上面的提示逐项排查（详见 docs/TROUBLESHOOTING.md）。`
);
process.exit(bad === 0 ? 0 : 1);
