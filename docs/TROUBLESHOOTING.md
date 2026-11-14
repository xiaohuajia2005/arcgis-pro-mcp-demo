# 常见故障排查

先跑自检，它会直接告诉你是哪一层出问题：

```bash
node doctor.mjs
```

---

## 1. 客户端里看不到任何工具

**这是最常见的情况，通常不是配置写错，而是服务启动即崩溃。**

排查顺序：

1. 先在命令行手动跑一次，看能不能起来：

   ```bash
   start-mcp.bat
   ```

   正常会打印 `[arcgis-pro-mcp] worker 就绪: {"ready":true,...}`。

2. 如果报「找不到 ArcGIS Pro 的 Python」，说明解释器路径不对，见第 3 节。

3. 如果报 `Cannot find module '@modelcontextprotocol/sdk'`，是依赖没装：

   ```bash
   npm install
   ```

4. 如果手动跑正常但客户端里还是没有，检查配置里的 `command` 是否为 **node 的绝对路径**
   （很多客户端不读系统 PATH），以及 `args` 里的 `server.mjs` 路径是否正确。

5. **改完配置必须重启客户端**，MCP 配置不是热加载的。

---

## 2. `pro_ping` 返回错误

| 报错 | 原因 | 处理 |
|---|---|---|
| `ModuleNotFoundError: No module named 'arcpy'` | 用错了解释器 | 必须指向 `arcgispro-py3\python.exe` |
| `Unable to checkout license` / 许可相关 | Pro 未登录或许可过期 | 打开 ArcGIS Pro 登录一次 |
| `操作失败：arcpy worker 启动后立即退出` | 解释器启动即崩 | 用 `start-mcp.bat` 手动跑，看 stderr 的详细报错 |
| `启动超时（120 秒）` | 首次加载 arcpy 较慢或许可服务卡住 | 等一会重试；仍失败则检查 Pro 能否正常启动 |

---

## 3. 找不到 ArcGIS Pro 的 Python

脚本会依次探测以下位置：

```
%ARCGIS_PRO_PYTHON%（环境变量，优先级最高）
C:\Program Files\ArcGIS\Pro\bin\Python\envs\arcgispro-py3\python.exe
D:\ArcGIS\bin\Python\envs\arcgispro-py3\python.exe
D:\Program Files\ArcGIS\Pro\bin\Python\envs\arcgispro-py3\python.exe
E:\ArcGIS\bin\Python\envs\arcgispro-py3\python.exe
```

装在别处的话，直接设环境变量：

```bat
set ARCGIS_PRO_PYTHON=你的路径\arcgispro-py3\python.exe
```

**不要用系统 Python。** 系统 Python 里没有 arcpy，装了也不行——arcpy 绑定的是 Pro 自己的运行时。

---

## 4. 保存工程时报 `OSError` / 写入失败

**原因是 ArcGIS Pro 正开着这个工程，`.aprx` 被独占锁定。**

ArcGIS Pro 打开工程期间，文件既不能写也不能重命名，这是正常行为。

处理：

1. 在 Pro 里关闭工程（提示保存时选「否」）
2. 确认 Pro 进程已退出
3. 重新执行保存

只读操作（查询、统计、临时分析）不受锁影响，可以照常使用。

---

## 5. 中文输出乱码

两个不同的原因：

- **worker 的日志在控制台乱码**：控制台代码页不是 UTF-8，在 bat 里已加 `chcp 65001`。
- **读 ArcGIS 生成的文件乱码**：部分工具（如 `SurfaceVolume`）输出的是 **GBK** 编码的 txt，
  用 UTF-8 读会乱，读取时要指定 `encoding="gbk"`。

---

## 6. 想确认到底报了什么错

服务端把所有日志都打到 **stderr**（不是 stdout，因为 stdout 被协议占用了）。

用 `start-mcp.bat` 启动可以直接看到全部日志。如果是在客户端里调用失败，
让客户端显示 server 的 stderr，或者临时改成手动启动对比。

---

## 7. 想重置状态

服务会把上次打开的工程记在 `state.json`（已被 `.gitignore` 忽略）。
如果它指向一个已经不存在的路径，删掉这个文件即可，服务下次启动不会自动打开工程。

```bat
del state.json
```
