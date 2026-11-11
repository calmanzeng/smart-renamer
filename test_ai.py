# -*- coding: utf-8 -*-
"""AI 模式测试：用本地模拟的 OpenAI 兼容接口验证请求格式与结果解析，
以及 AI 失败时自动回退本地兜底。不消耗真实 API 额度。"""
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import smart_renamer as sr  # noqa: E402

seen = {}
MOCK_THEME = "2025年第三季度 销售数据分析"


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(n))
        seen["path"] = self.path
        seen["body"] = body
        data = json.dumps({"choices": [{"message": {"content": MOCK_THEME}}]},
                          ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a):
        pass


srv = HTTPServer(("127.0.0.1", 0), Handler)
port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()

cfg = {**sr.DEFAULT_CONFIG, "ai_enabled": True,
       "base_url": "http://127.0.0.1:{}/v1".format(port),
       "api_key": "sk-test-mock", "model": "mock-model", "vision": True}

samples = os.path.join(HERE, "samples")

# 1) 文本文件走 AI
info = sr.process_one(os.path.join(samples, "会议记录_0304.txt"), cfg)
print("[文本 AI] {} → {} | 用了AI={}".format(info["old_name"], info["new_name"], info["used_ai"]))
assert info["used_ai"] and "销售" in info["new_name"], "AI 主题未生效"
body = seen["body"]
assert body["model"] == "mock-model"
assert body["messages"][0]["role"] == "system" and body["messages"][1]["role"] == "user"
print("  ✓ 请求格式正确（model/messages），返回结果已解析")

# 2) 图片走视觉
img_path = os.path.join(samples, "IMG_20250620_193000.jpg")
info2 = sr.process_one(img_path, cfg)
user_content = seen["body"]["messages"][1]["content"]
has_image = any(isinstance(c, dict) and "image_url" in c for c in user_content)
print("[图片 AI] {} → {} | 含图片请求={}".format(info2["old_name"], info2["new_name"], has_image))
assert info2["used_ai"], "图片 AI 未生效"
assert has_image, "视觉请求里没有图片数据"
print("  ✓ 视觉请求包含压缩后的 base64 图片")

# 3) AI 连接失败 → 自动回退本地
cfg_err = {**cfg, "base_url": "http://127.0.0.1:9/v1"}
info3 = sr.process_one(os.path.join(samples, "notice.md"), cfg_err)
print("[失败回退] {} → {} | 用了AI={} | 备注={}".format(
    info3["old_name"], info3["new_name"], info3["used_ai"], info3["note"][:40]))
assert not info3["used_ai"], "失败后应回退本地"
assert "通知" in info3["new_name"], "本地兜底结果异常"
print("  ✓ AI 不可用时自动回退本地总结")

print("\n✅ AI 模式测试全部通过")
srv.shutdown()