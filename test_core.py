# -*- coding: utf-8 -*-
"""本地模式核心功能测试：抽取 → 总结 → 命名 → 批量冲突处理。"""
import os
import sys

for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import smart_renamer as sr  # noqa: E402

cfg = {**sr.DEFAULT_CONFIG, "ai_enabled": False, "with_date": True}

samples_dir = os.path.join(HERE, "samples")
files = sorted(os.path.join(samples_dir, f) for f in os.listdir(samples_dir)
               if os.path.isfile(os.path.join(samples_dir, f)))
assert files, "先运行 make_samples.py 生成样本"

print("=" * 78)
print("{:<34} →  {:<30}  摘要".format("原文件", "新文件名"))
print("=" * 78)
rows = []
for f in files:
    info = sr.process_one(f, cfg)
    rows.append(info)
    short = info["summary"][:18]
    print("{:<34} →  {:<28}  {}".format(info["old_name"][:34], info["new_name"][:30], short))

# 批量命名（互不冲突）
plan = sr.make_plan(files, cfg, use_ai=False)
targets = [r["target"].lower() for r in plan]
assert len(targets) == len(set(targets)), "存在重复的目标名！"
print("\n批量计划：{} 个文件，目标名互不冲突 ✓".format(len(targets)))

# 关键断言
joined = " ".join(r["new_name"] for r in rows)
checks = [("会议纪要", "txt 样本应含会议纪要"), ("2025-Q1", "txt 样本应提取季度日期"),
          ("通知", "md 样本应含通知"), ("名单", "csv 应识别名单类型"),
          ("销售", "xlsx 应识别销售数据"), ("发布会", "pptx 应识别发布会"),
          ("协议", "docx 应识别协议"), ("照片", "jpg 应识别为照片")]
fails = 0
for kw, label in checks:
    ok = kw in joined
    print(("✓ " if ok else "✗ ") + label)
    if not ok:
        fails += 1

if fails:
    print("\n❌ {} 项未通过".format(fails))
    sys.exit(1)
print("\n✅ 本地模式全部通过")