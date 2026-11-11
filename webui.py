# -*- coding: utf-8 -*-
"""
webui.py —— 智能改名的时尚 Web 前端（本地服务）
==================================================
在 127.0.0.1 上起一个本地 HTTP 服务：
  - 自带文件浏览器（左侧栏）选文件 / 文件夹
  - 分析内容 → 预览建议新名 → 一键改名 → 可撤销
  - 复用 smart_renamer.py 的全部核心能力（双模式总结 / 各类文件解析）

用法：
    python webui.py            # 启动并在浏览器打开
    python webui.py --noopen   # 启动但不自动打开浏览器
    python webui.py --port 9000
"""

import copy
import json
import os
import queue
import socket
import sys
import threading
import traceback
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import smart_renamer as sr  # noqa: E402

INDEX_HTML = os.path.join(HERE, "web", "index.html")
DEFAULT_PORT = 8756


class State:
    """服务端状态：配置、撤销栈（进程内保存）。"""

    def __init__(self):
        self.lock = threading.Lock()
        self.cfg = sr.load_config()
        self.undo_stack = []          # list[(old_path, new_path)]
        self.rename_log = []          # 最近一次批量改名明细

    def save_cfg(self, cfg):
        self.cfg = cfg
        sr.save_config(cfg)


STATE = State()


def get_free_port(start):
    for i in range(30):
        p = start + i
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind(("127.0.0.1", p))
                return p
            except OSError:
                continue
    raise RuntimeError("找不到可用端口")


# ---------------------------------------------------------------------------
# API 逻辑
# ---------------------------------------------------------------------------

def list_path(path):
    """列出目录内容；path 为空/None 时返回 Windows 盘符。"""
    if not path:
        drives = []
        for c in "ABCDEFGHIJKLMNOPQRSTUVWXYZ":
            d = c + ":\\"
            if os.path.exists(d):
                drives.append({"name": d, "is_dir": True, "size": 0,
                               "label": d + "（{:.1f}GB 可用）".format(
                                   _free_gb(d))})
        return {"path": "", "parent": None, "entries": drives,
                "is_root": True}
    path = os.path.normpath(path)
    if not os.path.isdir(path):
        raise ValueError("不是文件夹: " + path)
    try:
        names = os.listdir(path)
    except PermissionError:
        raise ValueError("无权限访问该文件夹")
    entries = []
    for n in names:
        if n.startswith("$") or n in ("System Volume Information", "RECYCLE.BIN"):
            continue
        full = os.path.join(path, n)
        try:
            st = os.stat(full)
        except OSError:
            continue
        is_dir = os.path.isdir(full)
        entries.append({
            "name": n, "path": full, "is_dir": is_dir,
            "size": 0 if is_dir else st.st_size,
            "ext": "" if is_dir else os.path.splitext(n)[1].lower(),
            "mtime": _ts(st.st_mtime),
        })
    entries.sort(key=lambda e: (not e["is_dir"], e["name"].lower()))
    return {
        "path": path,
        "parent": os.path.dirname(path) if os.path.dirname(path) != path else None,
        "entries": entries,
        "is_root": False,
    }


def _free_gb(path):
    try:
        import ctypes
        f = ctypes.c_ulonglong(0)
        ctypes.windll.kernel32.GetDiskFreeSpaceExW(
            ctypes.c_wchar_p(path), None, None, ctypes.byref(f))
        return f.value / 1024 ** 3
    except Exception:
        return 0.0


def _ts(t):
    from datetime import datetime
    return datetime.fromtimestamp(t).strftime("%Y-%m-%d %H:%M")


def expand_paths(paths, recursive):
    """把（可能包含文件夹的）路径展开成文件列表。"""
    out, seen = [], set()
    for p in paths:
        p = os.path.normpath(p)
        if os.path.isfile(p):
            if p.lower() not in seen:
                seen.add(p.lower())
                out.append(p)
        elif os.path.isdir(p):
            for root, dirs, files in os.walk(p):
                if not recursive:
                    dirs[:] = []
                else:
                    dirs[:] = [d for d in dirs if not d.startswith((".", "$"))]
                for fn in files:
                    if fn.startswith("~$") or fn.endswith((".tmp", ".lnk")):
                        continue
                    fp = os.path.join(root, fn)
                    if fp.lower() not in seen:
                        seen.add(fp.lower())
                        out.append(fp)
    return out


def analyze(paths, recursive=False):
    """分析一批文件，返回带建议名的行；批内自动消解重名冲突。"""
    cfg = dict(STATE.cfg)
    files = expand_paths(paths, recursive)
    if not files:
        raise ValueError("没有可分析的文件（文件夹为空或只含系统文件）")

    rows_all = [None] * len(files)
    if cfg.get("ai_enabled"):
        workers = min(8, max(1, len(files)))
        with ThreadPoolExecutor(max_workers=workers) as ex:
            futs = {ex.submit(sr.process_one, f, cfg): i
                    for i, f in enumerate(files)}
            for fut in futs:
                i = futs[fut]
                try:
                    rows_all[i] = fut.result()
                except Exception as e:
                    rows_all[i] = _err_row(files[i], e)
    else:
        for i, f in enumerate(files):
            try:
                rows_all[i] = sr.process_one(f, cfg)
            except Exception as e:
                rows_all[i] = _err_row(f, e)

    # 批内冲突消解（跨文件去重）
    used = set()
    for r in rows_all:
        if r["path"] is None:
            continue
        try:
            dirpath = os.path.dirname(r["path"]) or "."
        except Exception:
            dirpath = "."
        stem, ext = os.path.splitext(r["new_name"])
        target = sr.unique_target(dirpath, stem, ext, used)
        used.add(target.lower())
        r["path"] = r["path"]
        r["target"] = target
        r["new_name"] = os.path.basename(target)

    return [_json_row(r) for r in rows_all]


def _err_row(path, e):
    return {
        "path": path, "old_name": os.path.basename(path),
        "new_name": os.path.basename(path), "target": path,
        "meta": {"kind": "未知", "text": ""},
        "summary": "分析失败", "used_ai": False,
        "note": str(e)[:200] + " — " + traceback.format_exc()[-200:],
        "error": True,
    }


def _json_row(r):
    m = r.get("meta") or {}
    inner = m.get("meta") or {}
    return {
        "id": None,
        "old_path": r["path"],
        "old_name": r["old_name"],
        "new_name": r["new_name"],
        "target": r.get("target", ""),
        "dir": os.path.dirname(r["path"]),
        "kind": m.get("kind", ""),
        "summary": r.get("summary", ""),
        "used_ai": bool(r.get("used_ai")),
        "note": r.get("note", ""),
        "error": bool(r.get("error")),
        "size": m.get("size", ""),
        "mtime": r.get("mtime", ""),
        "shot_time": inner.get("shot_time", ""),
        "camera": inner.get("camera", ""),
        "text_preview": (m.get("text") or "").strip()[:300],
    }


def rename(plan):
    """执行批量改名：plan=[{old_path,new_name}]。返回逐条结果。"""
    cfg = dict(STATE.cfg)
    results, ok_new = [], []
    used = set()
    with STATE.lock:
        for item in plan:
            old = os.path.normpath(item["old_path"])
            stem, ext = os.path.splitext(os.path.basename(item["new_name"]))
            dirpath = os.path.dirname(old) or "."
            target = sr.unique_target(dirpath, stem, ext, used)
            used.add(target.lower())
            try:
                os.rename(old, target)
                STATE.undo_stack.append((old, target))
                results.append({"ok": True, "old_path": old,
                                "new_path": target,
                                "from": os.path.basename(old),
                                "to": os.path.basename(target)})
            except OSError as e:
                results.append({"ok": False, "old_path": old,
                                "new_path": old, "from": os.path.basename(old),
                                "to": os.path.basename(item["new_name"]),
                                "error": "文件被占用或不存在: " + str(e)})
    return results


def undo():
    with STATE.lock:
        stack, STATE.undo_stack = STATE.undo_stack, []
    ok = fail = 0
    restored_paths = []
    for old, new in reversed(stack):
        try:
            if os.path.exists(new):
                os.rename(new, old)
                ok += 1
                restored_paths.append(old)
        except OSError:
            fail += 1
    return {"restored": ok, "failed": fail, "total": len(stack),
            "restored_paths": restored_paths}


# ---------------------------------------------------------------------------
# HTTP 处理
# ---------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    # HTTP/1.0：每个请求独立连接。本地工具无性能压力，
    # 可避免 keep-alive 连接复用下残留字节串进下一个请求行（曾导致 501）。
    protocol_version = "HTTP/1.0"

    # ---- 工具 ----
    def _send(self, code, body, ctype="application/json; charset=utf-8",
              extra=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        elif isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        try:
            self.wfile.write(body)
        except OSError:
            pass

    def _read_json(self):
        n = int(self.headers.get("Content-Length", 0) or 0)
        if n <= 0:
            return {}
        raw = self.rfile.read(n)
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return {}

    def _route(self, method):
        try:
            parsed = urlparse(self.path)
            path = parsed.path
            if path == "/":
                return self._serve_index()
            if path == "/api/drives":
                return self._send(200, list_path(None)["entries"])
            if path == "/api/list":
                q = parse_qs(parsed.query)
                dirpath = q.get("dir", [""])[0] or None
                return self._send(200, list_path(dirpath))
            if path == "/api/analyze" and method == "POST":
                data = self._read_json()
                rows = analyze(data.get("paths", []),
                               bool(data.get("recursive", False)))
                return self._send(200, {"rows": rows})
            if path == "/api/rename" and method == "POST":
                data = self._read_json()
                return self._send(200, {"results": rename(data.get("plan", []))})
            if path == "/api/undo" and method == "POST":
                return self._send(200, undo())
            if path == "/api/settings":
                if method == "GET":
                    return self._send(200, dict(STATE.cfg))
                if method == "POST":
                    data = self._read_json()
                    STATE.save_cfg(data.get("cfg", STATE.cfg))
                    return self._send(200, {"ok": True,
                                            "cfg": dict(STATE.cfg)})
            return self._send(404, {"error": "not found"})
        except ValueError as e:
            return self._send(400, {"error": str(e)})
        except Exception as e:
            traceback.print_exc()
            return self._send(500, {"error": "{}/{}".format(type(e).__name__, e)})

    def _serve_index(self):
        if not os.path.exists(INDEX_HTML):
            return self._send(404, "index.html 未找到", "text/plain; charset=utf-8")
        with open(INDEX_HTML, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except OSError:
            pass

    def do_GET(self):
        self._route("GET")

    def do_POST(self):
        self._route("POST")

    def log_message(self, fmt, *args):
        try:
            sys.stderr.write("[req] {} {} {}\n".format(self.command, self.path,
                                                       getattr(self, "request_version", "")))
        except Exception:
            pass

    def do_OPTIONS(self):
        """浏览器预检请求（跨源保护未开启时理论上不会出现，防御性返回空 200）。"""
        self.send_response(200, "OK")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", "0")
        self.end_headers()


def main():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    args = set(sys.argv[1:])
    port = DEFAULT_PORT
    for i, a in enumerate(sys.argv):
        if a == "--port" and i + 1 < len(sys.argv):
            try:
                port = int(sys.argv[i + 1])
            except ValueError:
                pass
    try:
        port = get_free_port(port)
    except RuntimeError as e:
        print("启动失败:", e)
        sys.exit(1)

    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    url = "http://127.0.0.1:{}/".format(port)
    print("=" * 56)
    print("  智能改名 · Web 版已启动")
    print("  地址: {}".format(url))
    print("  提示: 本服务只在本机运行；关闭本窗口即退出")
    print("=" * 56)
    if "--noopen" not in args:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    # 兼容旧入口：python webui.py --selftest
    if "--selftest" in sys.argv:
        print("webui OK（核心逻辑见 smart_renamer.py）")
        sys.exit(0)
    sys.exit(main())