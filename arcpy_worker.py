# -*- coding: utf-8 -*-
"""
ArcGIS Pro MCP - arcpy worker (常驻进程)

由 Node 端 server.mjs 以子进程方式启动，使用 ArcGIS Pro 自带解释器：
    D:\\ArcGIS\\bin\\Python\\envs\\arcgispro-py3\\python.exe

协议：stdin 读一行 JSON 请求 -> 执行 -> stdout 写一行 JSON 响应
    {"id": "1", "action": "list_layers", "params": {...}}
    {"id": "1", "ok": true, "data": {...}}
    {"id": "1", "ok": false, "error": "..."}

注意：arcpy 大量向 stdout 打印消息，会污染协议通道，因此启动时把
fd 1 复制给协议专用流，并把真正的 stdout 全部重定向到 stderr。
"""
import os
import sys
import json
import traceback

# ---------- 保护协议通道 ----------
_PROTO_FD = os.dup(1)
os.dup2(2, 1)                      # 后续所有 print / C 层输出 -> stderr
sys.stdout = sys.stderr
PROTO = os.fdopen(_PROTO_FD, "w", encoding="utf-8", buffering=1)

_ARCpy = None
_STATE = {"project": None, "path": None}


def send(obj):
    PROTO.write(json.dumps(obj, ensure_ascii=False) + "\n")
    PROTO.flush()


def arcpy_mod():
    global _ARCpy
    if _ARCpy is None:
        import arcpy
        import arcpy.mp  # noqa: F401
        try:
            arcpy.env.overwriteOutput = True
        except Exception:
            pass
        _ARCpy = arcpy
    return _ARCpy


# ---------- 通用工具 ----------
def _project(params):
    """获取工程对象。params 中带 aprx_path 则切换工程，否则用当前工程。"""
    arcpy = arcpy_mod()
    path = params.get("aprx_path")
    if path:
        path = os.path.abspath(path)
        if not os.path.exists(path):
            raise RuntimeError("工程文件不存在: %s" % path)
        # 每次都重新读取工程，确保能拿到用户刚在 Pro 里保存的最新状态
        _STATE["project"] = arcpy.mp.ArcGISProject(path)
        _STATE["path"] = path
        return _STATE["project"]
    if _STATE["project"] is None:
        raise RuntimeError(
            "尚未打开任何工程。请先调用 pro_open_project 并传入 .aprx 文件路径。"
        )
    return _STATE["project"]


def _resolve(ref, params):
    """把图层名 / 数据集路径 解析成 arcpy 可用的对象或路径。"""
    arcpy = arcpy_mod()
    if not ref:
        raise RuntimeError("缺少图层/数据集参数")
    ref = str(ref)
    if os.path.exists(ref):
        return ref

    proj = None
    try:
        proj = _project(params)
    except Exception:
        pass
    if proj is not None:
        map_name = params.get("map_name")
        maps = proj.listMaps(map_name) if map_name else proj.listMaps()
        for m in maps:
            hits = m.listLayers(ref)
            if hits:
                return hits[0]
        # 模糊匹配（大小写/部分名称）
        for m in maps:
            for lyr in m.listLayers():
                if lyr.isFeatureLayer or lyr.isRasterLayer:
                    if ref.lower() in lyr.name.lower():
                        return lyr
    # 退化：交给 arcpy 当路径处理
    return ref


def _default_gdb(params):
    """返回一个可用于输出的工作空间（优先当前工程默认 gdb）。"""
    arcpy = arcpy_mod()
    try:
        proj = _project(params)
        gdb = proj.defaultGeodatabase
        if gdb:
            return gdb
    except Exception:
        pass
    return arcpy.env.scratchGDB


def _out_fc(name, params, suffix=None):
    """把输出名转成完整路径；未提供时自动在默认地理数据库中生成唯一名称。"""
    arcpy = arcpy_mod()
    if name:
        name = str(name)
        if os.path.isabs(name) or name.lower().endswith((".shp", ".gdb", ".tif")):
            return name
        gdb = _default_gdb(params)
        if not gdb:
            return name
        return os.path.join(gdb, name)

    gdb = _default_gdb(params)
    if not gdb:
        raise RuntimeError("无法确定输出工作空间，请传入完整的输出路径")
    base = (
        suffix
        or params.get("layer")
        or params.get("in_dataset")
        or params.get("in_features")
        or "result"
    )
    base = os.path.splitext(os.path.basename(str(base)))[0] + "_out"
    return arcpy.CreateUniqueName(base, gdb)


def _pick_map(proj, map_name=None):
    """可靠地取地图：指定名优先，否则 activeMap，再否则第一个地图。

    独立进程打开 .aprx 时 activeMap 常为 None，必须兜底。
    """
    if map_name:
        maps = proj.listMaps(map_name)
        if not maps:
            raise RuntimeError("找不到地图: %s" % map_name)
        return maps[0]
    am = proj.activeMap
    if am is not None:
        return am
    maps = proj.listMaps()
    if not maps:
        raise RuntimeError("工程中没有任何地图")
    return maps[0]


def _find_layer_path(ref, params):
    """精确匹配图层名，返回其数据源路径；匹配不到返回 None。"""
    if not isinstance(ref, str) or not ref:
        return None
    if os.path.exists(ref):
        return ref
    try:
        proj = _project(params)
    except Exception:
        return None
    map_name = params.get("map_name")
    maps = proj.listMaps(map_name) if map_name else proj.listMaps()
    for m in maps:
        for lyr in m.listLayers():
            if lyr.name == ref and lyr.supports("DATASOURCE"):
                try:
                    return lyr.dataSource
                except Exception:
                    return None
    return None


def _safe(v):
    """把 arcpy 返回值转成可 JSON 序列化的形式。"""
    if v is None or isinstance(v, (bool, int, float, str)):
        return v
    if isinstance(v, (list, tuple)):
        return [_safe(x) for x in v]
    if isinstance(v, dict):
        return {str(k): _safe(x) for k, x in v.items()}
    return str(v)


def _extent(d):
    try:
        e = d.extent
        return {"xmin": e.XMin, "ymin": e.YMin, "xmax": e.XMax, "ymax": e.YMax}
    except Exception:
        return None


def _sr(d):
    try:
        sr = d.spatialReference
        return {"name": sr.name, "wkid": sr.factoryCode, "type": sr.type}
    except Exception:
        return None


# ---------- 动作实现 ----------
def act_ping(params):
    arcpy = arcpy_mod()
    info = arcpy.GetInstallInfo()
    return {
        "ok": True,
        "arcpy": info.get("Version"),
        "product": arcpy.ProductInfo(),
        "python": sys.version.split()[0],
    }


def act_open_project(params):
    arcpy = arcpy_mod()
    path = os.path.abspath(params["aprx_path"])
    if not os.path.exists(path):
        raise RuntimeError("工程文件不存在: %s" % path)
    proj = arcpy.mp.ArcGISProject(path)
    _STATE["project"] = proj
    _STATE["path"] = path
    return {
        "path": path,
        "maps": [
            {"name": m.name, "layers": len(m.listLayers())} for m in proj.listMaps()
        ],
        "layouts": [l.name for l in proj.listLayouts()],
        "default_gdb": proj.defaultGeodatabase,
    }


def act_project_info(params):
    proj = _project(params)
    return {
        "path": _STATE["path"],
        "default_gdb": proj.defaultGeodatabase,
        "home_folder": proj.homeFolder,
        "maps": [
            {
                "name": m.name,
                "map_type": getattr(m, "mapType", None),
                "layer_count": len(m.listLayers()),
                "spatial_reference": _sr(arcpy_mod().Describe(m)),
            }
            for m in proj.listMaps()
        ],
        "layouts": [{"name": l.name} for l in proj.listLayouts()],
        "active_map": getattr(proj.activeMap, "name", None),
    }


def act_list_maps(params):
    proj = _project(params)
    return {"maps": [m.name for m in proj.listMaps()]}


def act_list_layers(params):
    proj = _project(params)
    map_name = params.get("map_name")
    maps = proj.listMaps(map_name) if map_name else proj.listMaps()
    result = {}
    for m in maps:
        items = []
        for lyr in m.listLayers():
            item = {
                "name": lyr.name,
                "visible": getattr(lyr, "visible", None),
                "is_feature_layer": lyr.isFeatureLayer,
                "is_raster_layer": lyr.isRasterLayer,
                "is_group_layer": lyr.isGroupLayer,
                "data_source": None,
                "geometry_type": None,
            }
            try:
                if lyr.supports("DATASOURCE"):
                    item["data_source"] = lyr.dataSource
                if lyr.isFeatureLayer:
                    item["geometry_type"] = arcpy_mod().Describe(lyr).shapeType
            except Exception:
                pass
            items.append(item)
        result[m.name] = items
    return result


def act_describe(params):
    arcpy = arcpy_mod()
    ds = _resolve(params.get("dataset"), params)
    d = arcpy.Describe(ds)
    out = {
        "name": d.name,
        "data_type": d.dataType,
        "catalog_path": getattr(d, "catalogPath", None),
        "shape_type": getattr(d, "shapeType", None),
        "spatial_reference": _sr(d),
        "extent": _extent(d),
    }
    if hasattr(d, "fields"):
        out["fields"] = [
            {"name": f.name, "type": f.type, "length": getattr(f, "length", None)}
            for f in d.fields
        ]
    try:
        if d.dataType in ("FeatureClass", "ShapeFile", "FeatureLayer"):
            out["feature_count"] = int(arcpy.management.GetCount(ds)[0])
    except Exception:
        pass
    return out


def act_list_fields(params):
    arcpy = arcpy_mod()
    ds = _resolve(params.get("dataset"), params)
    d = arcpy.Describe(ds)
    return {
        "dataset": d.name,
        "fields": [
            {
                "name": f.name,
                "alias": getattr(f, "aliasName", None),
                "type": f.type,
                "length": getattr(f, "length", None),
                "nullable": getattr(f, "isNullable", None),
            }
            for f in d.fields
        ],
    }


def act_query_attributes(params):
    arcpy = arcpy_mod()
    ds = _resolve(params.get("dataset"), params)
    fields = params.get("fields")
    limit = int(params.get("limit") or 20)
    where = params.get("where") or None

    if not fields:
        d = arcpy.Describe(ds)
        skip = {"Shape", "SHAPE", "Shape_Length", "Shape_Area", "OBJECTID", "OID"}
        fields = [f.name for f in d.fields if f.name not in skip][:15]
    if isinstance(fields, str):
        fields = [f.strip() for f in fields.split(",") if f.strip()]

    rows = []
    try:
        with arcpy.da.SearchCursor(ds, fields, where) as cur:
            for i, row in enumerate(cur):
                if i >= limit:
                    break
                rows.append(dict(zip(fields, [_safe(v) for v in row])))
    except RuntimeError as e:
        # 字段名写错时，把可用字段回给调用方，方便一次改对
        d = arcpy.Describe(ds)
        avail = [f.name for f in d.fields]
        raise RuntimeError(
            "%s；该数据集可用字段为: %s" % (e, ", ".join(avail))
        )
    return {"dataset": arcpy.Describe(ds).name, "fields": fields, "count_returned": len(rows), "rows": rows}


def act_run_geoprocessing(params):
    """调用任意 ArcGIS 地理处理工具，如 'analysis.Buffer' / 'management.Project'。"""
    arcpy = arcpy_mod()
    tool = params.get("tool")
    if not tool:
        raise RuntimeError("缺少 tool 参数，例如 'analysis.Buffer'")
    args = params.get("parameters") or []
    if isinstance(args, str):
        args = [a.strip() for a in args.split(";")]

    # GP 工具不认“图层名”这种人话，先把能精确匹配到图层的字符串换成数据源路径
    resolved = []
    for a in args:
        hit = _find_layer_path(a, params) if isinstance(a, str) else None
        resolved.append(hit if hit else a)
    args = resolved

    # 支持 "analysis.Buffer" 和 "Buffer_analysis" 两种写法
    obj = arcpy
    for part in tool.split("."):
        obj = getattr(obj, part)

    res = obj(*args)
    out = {"tool": tool, "parameters": [_safe(a) for a in args]}
    if res is not None:
        try:
            out["result"] = str(res)
        except Exception:
            out["result"] = _safe(res)
    try:
        out["messages"] = arcpy.GetMessages().splitlines()[-15:]
    except Exception:
        pass
    return out


def act_buffer(params):
    arcpy = arcpy_mod()
    src = _resolve(params.get("layer"), params)
    out_fc = _out_fc(params.get("out"), params)
    dist = str(params.get("distance") or "100 Meters")
    dissolve = params.get("dissolve") or "NONE"
    side = params.get("side") or "FULL"
    end_type = params.get("end_type") or "ROUND"
    # 签名: Buffer(in, out, distance, {line_side}, {line_end_type}, {dissolve_option}, ...)
    arcpy.analysis.Buffer(src, out_fc, dist, side, end_type, dissolve)
    return {"output": out_fc, "distance": dist, "count": str(arcpy.management.GetCount(out_fc))}


def act_clip(params):
    arcpy = arcpy_mod()
    src = _resolve(params.get("in_features"), params)
    clip_fc = _resolve(params.get("clip_features"), params)
    out_fc = _out_fc(params.get("out"), params)
    arcpy.analysis.Clip(src, clip_fc, out_fc)
    return {"output": out_fc, "count": str(arcpy.management.GetCount(out_fc))}


def act_project_data(params):
    arcpy = arcpy_mod()
    src = _resolve(params.get("in_dataset"), params)
    out_fc = _out_fc(params.get("out"), params)
    epsg = params.get("epsg")
    wkt = params.get("wkt")
    if wkt:
        sr = arcpy.SpatialReference()
        sr.loadFromString(wkt)
    elif epsg:
        sr = arcpy.SpatialReference(int(str(epsg).replace("EPSG:", "")))
    else:
        raise RuntimeError("请提供目标坐标系 epsg 或 wkt")
    arcpy.management.Project(src, out_fc, sr)
    return {"output": out_fc, "spatial_reference": _sr(arcpy.Describe(out_fc))}


def act_export_map(params):
    arcpy = arcpy_mod()
    proj = _project(params)
    map_name = params.get("map_name")
    out = os.path.abspath(params["out"])
    dpi = int(params.get("dpi") or 150)
    m = _pick_map(proj, map_name)
    ext = os.path.splitext(out)[1].lower()
    view = m.defaultView
    if ext == ".pdf":
        view.exportToPDF(out, resolution=dpi)
    elif ext == ".jpg":
        view.exportToJPEG(out, resolution=dpi)
    else:
        view.exportToPNG(out, resolution=dpi)
    return {"output": out, "map": m.name, "dpi": dpi}


def act_export_layout(params):
    arcpy = arcpy_mod()
    proj = _project(params)
    name = params.get("layout_name")
    out = os.path.abspath(params["out"])
    dpi = int(params.get("dpi") or 150)
    layouts = proj.listLayouts(name) if name else proj.listLayouts()
    if not layouts:
        raise RuntimeError("找不到布局: %s" % name)
    lay = layouts[0]
    ext = os.path.splitext(out)[1].lower()
    if ext == ".pdf":
        lay.exportToPDF(out, resolution=dpi)
    elif ext == ".jpg":
        lay.exportToJPEG(out, resolution=dpi)
    else:
        lay.exportToPNG(out, resolution=dpi)
    return {"output": out, "layout": lay.name, "dpi": dpi}


def act_save_project(params):
    proj = _project(params)
    proj.save()
    return {"saved": True, "path": _STATE["path"]}


def act_run_python(params):
    """兜底：执行任意 arcpy 代码片段，返回变量 result 的值。"""
    code = params.get("code")
    if not code:
        raise RuntimeError("缺少 code 参数")
    arcpy = arcpy_mod()
    env = {"arcpy": arcpy, "params": params, "result": None}
    try:
        proj = _project({})
        env["project"] = proj
        env["aprx"] = proj
        env["active_map"] = _pick_map(proj)
        env["maps"] = proj.listMaps()
        env["gdb"] = proj.defaultGeodatabase
    except Exception:
        pass
    _orig = sys.stdout
    try:
        exec(compile(code, "<mcp>", "exec"), env, env)
    finally:
        sys.stdout = _orig
    return {"result": _safe(env.get("result"))}


ACTIONS = {
    "ping": act_ping,
    "open_project": act_open_project,
    "project_info": act_project_info,
    "list_maps": act_list_maps,
    "list_layers": act_list_layers,
    "describe": act_describe,
    "list_fields": act_list_fields,
    "query_attributes": act_query_attributes,
    "run_geoprocessing": act_run_geoprocessing,
    "buffer": act_buffer,
    "clip": act_clip,
    "project_data": act_project_data,
    "export_map": act_export_map,
    "export_layout": act_export_layout,
    "save_project": act_save_project,
    "run_python": act_run_python,
}


def main():
    # Windows 下管道默认是 cp936，必须强制 utf-8 才能正确接收中文参数
    try:
        sys.stdin.reconfigure(encoding="utf-8")
    except Exception:
        pass
    send({"ready": True, "python": sys.version.split()[0]})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get("id")
            action = req.get("action")
            params = req.get("params") or {}
            fn = ACTIONS.get(action)
            if fn is None:
                raise RuntimeError("未知 action: %s" % action)
            data = fn(params)
            send({"id": req_id, "ok": True, "data": data})
        except Exception as e:
            send(
                {
                    "id": req_id,
                    "ok": False,
                    "error": "%s: %s" % (type(e).__name__, e),
                    "traceback": traceback.format_exc()[-2000:],
                }
            )


if __name__ == "__main__":
    try:
        arcpy_mod()
    except Exception as e:
        send({"ready": False, "error": "arcpy 加载失败: %s" % e})
        sys.exit(1)
    main()
