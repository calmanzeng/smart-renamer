# -*- coding: utf-8 -*-
"""
smart_renamer.py —— 按内容智能改名工具
=========================================
读取文件内容（文本 / 表格 / 演示文稿 / Word / PDF / 图片…），
抓取重点、总结主题，然后把这个主题作为新的文件名。

- 双模式总结：配置了 OpenAI 兼容 API（DeepSeek / OpenAI / 本地 Ollama /
  硅基流动等）就用 AI 提炼主题，链接失败或没配置时自动退回本地关键词抽取。
- 支持单份 / 多份 / 整个文件夹批量处理。
- 图形界面：添加文件 → 自动预览新名字 → 一键改名，可撤销。

用法：
    python smart_renamer.py            # 打开图形界面
    python smart_renamer.py --selftest # 内部自检（不弹出界面）
"""

import base64
import io
import json
import os
import queue
import re
import sys
import threading
import time
import traceback
import urllib.error
import urllib.request
from collections import Counter
from datetime import datetime

APP_NAME = "智能改名"
CONFIG_PATH = os.path.join(os.path.expanduser("~"), ".smart_renamer.json")

# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------

DEFAULT_CONFIG = {
    "ai_enabled": True,           # 是否优先用 AI 总结
    "base_url": "https://api.openai.com/v1",
    "api_key": "",
    "model": "gpt-4o-mini",
    "lang": "zh",                 # zh / en
    "max_len": 40,                # 新文件名最大长度（不含扩展名）
    "with_date": True,            # 名字里带上日期
    "vision": True,               # 图片是否用 AI 视觉识别
    "recursive": False,           # 添加文件夹时是否递归子目录
}


def load_config():
    cfg = dict(DEFAULT_CONFIG)
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            cfg.update(json.load(f))
    except Exception:
        pass
    return cfg


def save_config(cfg):
    try:
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print("保存配置失败:", e)


# ---------------------------------------------------------------------------
# 文件内容抽取
# ---------------------------------------------------------------------------

# 可直接当文本读的类型
TEXT_EXTS = {
    ".txt", ".md", ".markdown", ".log", ".csv", ".tsv", ".json", ".yaml",
    ".yml", ".xml", ".ini", ".cfg", ".conf", ".html", ".htm", ".css",
    ".js", ".jsx", ".ts", ".tsx", ".py", ".java", ".c", ".cpp", ".h",
    ".hpp", ".cs", ".go", ".rs", ".php", ".rb", ".sql", ".sh", ".bat",
    ".ps1", ".vbs", ".rtf", ".srt", ".vtt", ".toml", ".properties",
    ".tex", ".bib", ".env",
}
IMG_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif", ".tiff", ".tif"}
OFFICE_EXTS = {".docx", ".xlsx", ".xlsm", ".pptx", ".ppt", ".xls", ".doc"}
OTHER_EXTS = {".pdf", ".zip", ".rar", ".7z", ".mp3", ".mp4", ".mkv", ".avi", ".mov", ".wav"}

TYPE_NAMES = {
    ".txt": "文本", ".md": "Markdown", ".log": "日志", ".csv": "表格数据",
    ".json": "数据", ".html": "网页", ".docx": "Word 文档", ".xlsx": "Excel 表格",
    ".pptx": "PPT 演示", ".pdf": "PDF 文档", ".jpg": "图片", ".png": "图片",
    ".doc": "Word(旧版)", ".xls": "Excel(旧版)", ".ppt": "PPT(旧版)",
}

STOPWORDS_EN = {
    "the", "and", "for", "with", "from", "this", "that", "are", "was",
    "were", "have", "has", "had", "not", "but", "you", "your", "our",
    "their", "they", "them", "will", "would", "can", "could", "should",
    "all", "any", "each", "its", "into", "about", "than", "then", "there",
    "these", "those", "upon", "also", "been", "being", "were", "what",
    "when", "where", "which", "who", "whom", "how", "why", "though",
    "just", "very", "more", "most", "some", "such", "only", "own",
    "same", "so", "too", "very", "well", "one", "two", "new", "file",
}

DOC_TYPE_PATTERNS = [
    (r"会议纪要|会谈纪要|纪要", "会议纪要"),
    (r"通知|公告|告示", "通知公告"),
    (r"销售(数据|报表|分析|统计|额)", "销售数据"),
    (r"数据分析|统计报表|统计表|数据报表|指标", "数据分析"),
    (r"合同(书)?|协议书|协议|补充协议|框架(协议|合同)", "合同协议"),
    (r"招标|投标|标书", "标书"),
    (r"预算|决算|报销|发票|账目|台账|对账单", "财务"),
    (r"客户名单|通讯录|联系人|姓名.*?(部门|电话)|人员名单|花名册", "名单"),
    (r"简历|求职|应聘|面试", "简历"),
    (r"工作总结|小结|季度总结|年度总结", "总结"),
    (r"工作计划|工作安排|排期|计划表|行事历", "工作计划"),
    (r"培训|教程|课件|讲义|手册|指南|说明(书)?$", "教程手册"),
    (r"方案|策划|提案", "方案"),
    (r"制度|规定|规范|条例|章程|办法", "制度规范"),
    (r"申请书|申请表|审批表|备案表", "申请表单"),
    (r"行程|日程|安排表|时间表|会议安排", "日程安排"),
    (r"请假|调休|考勤|排班", "考勤"),
    (r"测试|用例|缺陷|bug|BUG", "测试"),
    (r"需求文档|PRD|产品需求", "需求文档"),
    (r"设计稿|效果图|原型", "设计稿"),
    (r"日报|周报|月报|工作报告", "工作报告"),
    (r"发布会|路演", "发布会"),
    (r"笔记|心得|摘录|读书", "笔记"),
    (r"邀请函|请柬", "邀请函"),
    (r"贺卡|祝福|致辞|发言稿", "致辞贺卡"),
    (r"总结", "总结"),
    (r"清单|明细|目录", "清单"),
    (r"记录|日志", "记录"),
]

QMAP = {"一": "1", "二": "2", "三": "3", "四": "4",
        "1": "1", "2": "2", "3": "3", "4": "4"}


def read_text_smart(path, limit=20000):
    """按多种编码尝试读文本，取前 limit 字符。"""
    with open(path, "rb") as f:
        raw = f.read()
    for enc in ("utf-8-sig", "utf-8", "gb18030", "big5", "utf-16"):
        try:
            return raw.decode(enc)[:limit]
        except (UnicodeDecodeError, LookupError):
            continue
    return raw.decode("latin-1", errors="replace")[:limit]


def _try_import(name):
    try:
        return __import__(name)
    except Exception:
        return None


def extract_docx(path):
    docx = _try_import("docx")
    if not docx:
        return None, "缺少 python-docx 库，无法解析"
    d = docx.Document(path)
    parts = []
    for p in d.paragraphs:
        t = p.text.strip()
        if t:
            parts.append(t)
    for tb in d.tables[:3]:
        for row in tb.rows[:4]:
            cells = [c.text.strip() for c in row.cells]
            parts.append(" | ".join(x for x in cells if x))
    return "\n".join(parts)[:12000], ""


def extract_pptx(path):
    pptx = _try_import("pptx")
    if not pptx:
        return None, "缺少 python-pptx 库，无法解析"
    prs = pptx.Presentation(path)
    parts = []
    for idx, slide in enumerate(prs.slides, 1):
        lines = []
        for shape in slide.shapes:
            if not shape.has_text_frame:
                continue
            for para in shape.text_frame.paragraphs:
                t = "".join(run.text for run in para.runs).strip()
                if t:
                    lines.append(t)
        if lines:
            parts.append("[第{}页] {}".format(idx, " / ".join(lines)))
    return "\n".join(parts)[:12000], ""


def extract_xlsx(path):
    openpyxl = _try_import("openpyxl")
    if not openpyxl:
        return None, "缺少 openpyxl 库，无法解析"
    try:
        wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    except Exception:
        wb = None
    if wb is None:
        try:
            wb = openpyxl.load_workbook(path, read_only=True, data_only=False)
        except Exception:
            wb = None
    if wb is None:
        return None, "表格文件可能已损坏或加密"
    parts = []
    for ws in wb.worksheets:
        rows = []
        for row in ws.iter_rows(values_only=True):
            vals = [str(v).strip() for v in row if v is not None and str(v).strip()]
            if vals:
                rows.append(vals)
            if len(rows) >= 6:
                break
        if rows:
            head = rows[0][:8]
            parts.append("[工作表 {}] {}".format(ws.title, " | ".join(head)))
            for r in rows[1:3]:
                parts.append(" ".join(str(x) for x in r[:8]))
    wb.close()
    return "\n".join(parts)[:12000], ""


def extract_pdf(path):
    text, note = "", ""
    try:
        from pypdf import PdfReader
        reader = PdfReader(path)
        pages = []
        for i, page in enumerate(reader.pages[:8]):
            t = (page.extract_text() or "").strip()
            if t:
                pages.append("[第{}页] {}".format(i + 1, t[:1500]))
        text = "\n".join(pages)[:12000]
    except ImportError:
        note = "缺少 pypdf 库，仅提取基础信息"
    except Exception as e:
        note = "PDF 解析失败: {}".format(e)
    if not text:
        # 兜底：从原始字节里找 /Title 元信息
        try:
            with open(path, "rb") as f:
                raw = f.read(200000)
            m = re.search(rb"/Title\s*\(([^)]{1,200})\)", raw)
            if m:
                text = m.group(1).decode("latin-1", errors="replace")
                note = (note + "（标题元信息）").strip()
        except Exception:
            pass
    return text, note


def extract_image(path):
    """返回 (文本内容, 元信息 dict, 备注)。文本来自 OCR（可选），元信息含拍摄时间等。"""
    meta = {}
    text, note = "", ""
    pil = _try_import("PIL")
    if pil:
        try:
            from PIL import Image, ExifTags
            img = Image.open(path)
            meta["size"] = "{}x{}".format(*img.size)
            exif = {}
            try:
                raw_exif = img._getexif() or {}
                for k, v in raw_exif.items():
                    key = ExifTags.TAGS.get(k, k)
                    exif[key] = v
            except Exception:
                pass
            for dt_key in ("DateTimeOriginal", "DateTimeDigitized", "DateTime"):
                if exif.get(dt_key):
                    meta["shot_time"] = str(exif[dt_key]).replace(":", "-", 2)
                    break
            make = str(exif.get("Make", ""))
            model = str(exif.get("Model", ""))
            meta["camera"] = " ".join(x for x in (make, model) if x)
            img.close()
        except Exception as e:
            note = "图片元信息读取失败: {}".format(e)
        # OCR（装了 pytesseract 和语言包才启用）
        try:
            import pytesseract
            lang = "chi_sim+eng"
            try:
                text = (pytesseract.image_to_string(Image.open(path), lang=lang) or "").strip()
            except Exception:
                text = ""
        except ImportError:
            pass
    else:
        note = "缺少 Pillow 库，仅按文件属性处理"
    return text, meta, note


def extract_content(path):
    """按扩展名抽取可读内容，返回 dict：{kind, text, meta, note}"""
    ext = os.path.splitext(path)[1].lower()
    name = os.path.basename(path)
    meta, note = {}, ""
    text = ""
    kind = TYPE_NAMES.get(ext, ext.lstrip(".") or "文件").upper()

    if ext in TEXT_EXTS:
        try:
            text = read_text_smart(path)
        except Exception as e:
            note = "读取失败: {}".format(e)
    elif ext == ".docx":
        text, note = extract_docx(path)
    elif ext == ".pptx":
        text, note = extract_pptx(path)
    elif ext in (".xlsx", ".xlsm"):
        text, note = extract_xlsx(path)
    elif ext == ".pdf":
        text, note = extract_pdf(path)
    elif ext in IMG_EXTS:
        text, meta, note = extract_image(path)
    elif ext in (".doc", ".xls", ".ppt"):
        note = "旧版 Office 格式，本工具暂不解析正文，请另存为新格式后效果更佳"
    elif ext in OTHER_EXTS:
        note = "该类型没有可解析的正文，将按日期与原文件名整理"
    else:
        note = "未知类型，将按日期与原文件名整理"

    if not meta:
        try:
            meta["mtime"] = datetime.fromtimestamp(os.path.getmtime(path)).strftime("%Y-%m-%d")
        except Exception:
            pass
    return {"kind": kind, "text": text, "meta": meta, "note": note}


# ---------------------------------------------------------------------------
# 主题提取：日期 / 文件类型 / 关键词
# ---------------------------------------------------------------------------

def find_date(meta, text, name):
    """尽量找一个日期：正文里的日期 > 拍摄时间 > 文件名里的日期 > 修改时间。"""
    text = text or ""
    date_str = ""

    # 1) 年 + 季度：2025年一季度 / 2025年第一季度 / 2025 Q1
    m = re.search(r"(20\d{2})年[^。\n;；]{0,12}?([一二三四1-4])季度", text)
    if m and m.group(2) in QMAP:
        date_str = "{}-Q{}".format(m.group(1), QMAP[m.group(2)])
    if not date_str:
        ym = re.search(r"(20\d{2})", text)
        m = re.search(r"Q\s*([1-4])\b", text, re.IGNORECASE)
        if ym and m:
            date_str = "{}-Q{}".format(ym.group(1), m.group(1).upper())

    # 2) 年月日 / 年月
    if not date_str:
        m = re.search(r"(20\d{2})年\s*(\d{1,2})月(?:\s*(\d{1,2})日?)?", text)
        if m:
            if m.group(3):
                date_str = "{}-{}-{}".format(m.group(1), m.group(2).zfill(2), m.group(3).zfill(2))
            else:
                date_str = "{}年{}月".format(m.group(1), m.group(2))
    if not date_str:
        m = re.search(r"(20\d{2})-(\d{1,2})-(\d{1,2})", text)
        if m and 1 <= int(m.group(2)) <= 12 and 1 <= int(m.group(3)) <= 31:
            date_str = "{}-{}-{}".format(m.group(1), m.group(2).zfill(2), m.group(3).zfill(2))
    if not date_str:
        m = re.search(r"(20\d{2})[-/.](\d{1,2})(?![-/.]\d)", text)
        if m and 1 <= int(m.group(2)) <= 12:
            date_str = "{}年{}月".format(m.group(1), m.group(2).zfill(2))
    if not date_str:
        m = re.search(r"(20\d{2})年", text)
        if m:
            date_str = m.group(1) + "年"

    # 3) 文件名里的时间戳 20250101_093000 / 2025-01-01 09.30 / IMG_20250101
    if not date_str:
        m = re.search(r"(20\d{2})[-_.]?(\d{2})[-_.]?(\d{2})", name)
        if m and 1 <= int(m.group(2)) <= 12 and 1 <= int(m.group(3)) <= 31:
            date_str = "{}-{}-{}".format(m.group(1), m.group(2), m.group(3))
    if not date_str:
        m = re.search(r"(20\d{2})年(\d{1,2})月", name)
        if m:
            date_str = "{}年{}月".format(m.group(1), m.group(2))

    # 4) 照片拍摄时间 / 文件修改时间
    if not date_str and meta:
        inner = meta.get("meta") or meta
        if inner.get("shot_time"):
            date_str = str(inner["shot_time"])[:10]
        elif inner.get("mtime"):
            date_str = inner["mtime"]
    return date_str


def find_doc_type(text):
    if not text:
        return ""
    for pat, label in DOC_TYPE_PATTERNS:
        if re.search(pat, text):
            return label
    return ""


def find_heading(text):
    """找第一行像标题的短行。"""
    if not text:
        return ""
    for line in text.splitlines()[:30]:
        line = line.strip().lstrip("#* \t").strip()
        if not line or len(line) > 20:
            continue
        if line.endswith(("。", "，", "；", "！", "？", "、", ":", "：", ",", ";")):
            continue
        if re.search(r"^.{0,3}[·\-—+]", line):
            continue
        if re.search(r"[,，|/]", line):  # 含分隔符的更像表格行
            continue
        return line
    return ""


def top_keywords(text, n=3):
    """英文单词统计 + （可选 jieba）中文分词统计。"""
    words = []
    if text:
        words += re.findall(r"[A-Za-z][A-Za-z0-9_-]{2,}", text.lower())
    words = [w for w in words if w not in STOPWORDS_EN and not w.isdigit()]
    counter = Counter(words)
    top = [w for w, _ in counter.most_common(n)]
    jieba = _try_import("jieba")
    if jieba and text:
        cjk = re.findall(r"[\u4e00-\u9fff]{2,}", text)
        cjk_text = " ".join(cjk)
        if cjk_text:
            toks = [t.strip() for t in jieba.lcut(cjk_text)]
            toks = [t for t in toks if len(t) >= 2 and not re.fullmatch(r"[\d\W]+", t)]
            cn_counter = Counter(toks)
            top += [w for w, _ in cn_counter.most_common(n) if w not in top][:n]
    # 去掉纯数字词，避免 "2025" 之类作为关键词
    return [w for w in top if not re.fullmatch(r"\d+", w)]


def local_summarize(meta, text, lang="zh"):
    """本地兜底：日期 + 文档类型 + 关键词/标题 → 主题名。"""
    doc_type = find_doc_type(text)
    kw = top_keywords(text, n=3)
    heading = find_heading(text)
    label_parts = []
    if doc_type:
        label_parts.append(doc_type)
    if kw:
        label_parts += kw[:2]
    elif heading and not doc_type:
        # 有明确的文档类型时不再叠标题，避免「合同协议 合作框架协议」这类重复
        label_parts.append(heading[:12])
    if not label_parts:
        kind = str(meta.get("kind", "")) if meta else ""
        if "图片" in kind:
            label_parts.append("照片")
        elif any(k in kind for k in ("视频", "音频", "压缩")):
            label_parts.append("文件")
        else:
            label_parts.append("资料")
    # 去重（如文档类型和标题相同）
    seen, out = set(), []
    for x in label_parts:
        if x not in seen:
            seen.add(x)
            out.append(x)
    label = " ".join(out)
    if lang == "en" and not re.search(r"[\u4e00-\u9fff]", label):
        label = " ".join(re.findall(r"[A-Za-z0-9]+", label))[:30]
    return label


# ---------------------------------------------------------------------------
# 文件名组装
# ---------------------------------------------------------------------------

ILLEGAL_CHARS = re.compile(r'[\\/:*?"<>|\x00-\x1f]')
RESERVED = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)),
            *(f"LPT{i}" for i in range(1, 10))}


def sanitize_name(name, max_len=None):
    name = ILLEGAL_CHARS.sub("_", name).strip().strip(".")
    name = re.sub(r"\s+", " ", name)
    while name != name.replace("__", "_"):
        name = name.replace("__", "_")
    if not name:
        name = "未命名"
    if max_len and len(name) > max_len:
        name = name[:max_len].rstrip(" _.-")
    if name.upper() in RESERVED:
        name = "_" + name
    return name or "未命名"


def build_new_name(path, meta, cfg, ai_theme=None):
    """把各个方面拼成最终新文件名主体（不含扩展名）。"""
    ext = os.path.splitext(path)[1]
    original_stem = os.path.splitext(os.path.basename(path))[0]

    theme = ai_theme or local_summarize(meta, meta.get("text", ""), cfg.get("lang", "zh"))
    theme = sanitize_name(theme)

    date_str = find_date(meta, meta.get("text", ""), os.path.basename(path))

    parts = []
    if cfg.get("with_date", True) and date_str:
        if not theme.startswith(date_str[:7]) and not theme.startswith(date_str[:4]):
            parts.append(date_str)
    parts.append(theme)

    name = " ".join(p for p in parts if p)
    name = sanitize_name(name, max_len=cfg.get("max_len", 40))
    if len(name) < 2:
        name = sanitize_name(original_stem, max_len=cfg.get("max_len", 40))
    return name + ext


def unique_target(dirpath, stem, ext, used):
    """冲突时追加 (1) (2)…"""
    cand = os.path.join(dirpath, stem + ext)
    i = 1
    key = cand.lower()
    while os.path.exists(cand) or key in used:
        cand = os.path.join(dirpath, "{} ({}){}".format(stem, i, ext))
        key = cand.lower()
        i += 1
    return cand


# ---------------------------------------------------------------------------
# AI 总结（OpenAI 兼容接口；图片支持视觉）
# ---------------------------------------------------------------------------

def _http_json(url, payload, headers, timeout=90):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def image_to_data_url(path, max_side=1024, quality=82):
    """压缩图片并转 base64 data URL，避免请求过大。"""
    from PIL import Image
    img = Image.open(path)
    img = img.convert("RGB")
    w, h = img.size
    if max(w, h) > max_side:
        scale = max_side / max(w, h)
        img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=quality)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def build_ai_prompt(meta, cfg, include_image=False):
    lang = cfg.get("lang", "zh")
    if lang == "en":
        sys_msg = (
            "You are a file-organizing assistant. Given a file's extracted "
            "content or metadata, produce ONE short, accurate theme for "
            "renaming the file. Rules: output only the name stem (no "
            "extension, no quotes, no punctuation decorations), 4-12 words, "
            "in English."
        )
    else:
        sys_msg = (
            "你是文件整理助手。根据用户给出的文件内容/元信息，提炼一个简短贴切的主题，"
            "用于给这个文件重命名。规则：只输出文件名主体（不含扩展名、不含引号、"
            "不带任何解释），中文 2~18 个字；若内容里有明确日期/季度，可带上，"
            "例如「2025年第三季度 销售数据分析」。"
        )
    kind = meta.get("kind", "")
    text = (meta.get("text") or "").strip()[:3000]
    date_s = find_date(meta, text, meta.get("name", ""))
    lines = ["文件类型: {}".format(kind)]
    if date_s:
        lines.append("相关日期: {}".format(date_s))
    if meta.get("meta", {}).get("camera"):
        lines.append("拍摄设备: {}({})".format(meta["meta"]["camera"], meta["meta"].get("size", "")))
    elif meta.get("meta", {}).get("size"):
        lines.append("图片尺寸: {}".format(meta["meta"]["size"]))
    if text:
        lines.append("内容摘录:")
        lines.append(text)
    if not text:
        lines.append("(正文无法读取，只能依据以上元信息命名)")
    return sys_msg, "\n".join(lines)


def ai_summarize(meta, cfg):
    """调用 OpenAI 兼容接口总结主题；失败返回 None，并给出错误信息。"""
    base = (cfg.get("base_url") or "").rstrip("/")
    key = (cfg.get("api_key") or "").strip()
    model = cfg.get("model") or "gpt-4o-mini"
    if not base:
        return None, "未配置 API 地址"
    if not key:
        return None, "未配置 API Key"

    sys_msg, user_text = build_ai_prompt(meta, cfg)
    is_img = meta.get("kind") in ("图片", "IMAGE") and cfg.get("vision", True)
    content = user_text
    if is_img:
        try:
            data_url = image_to_data_url(meta.get("path", ""))
            content = [{"type": "text", "text": user_text},
                       {"type": "image_url", "image_url": {"url": data_url}}]
        except Exception as e:
            content = user_text + "\n(图片发送失败，仅凭文字信息命名: {})".format(e)
            is_img = False

    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": sys_msg},
            {"role": "user", "content": content},
        ],
        "temperature": 0.3,
        "max_tokens": 120,
    }
    headers = {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + key,
    }
    try:
        resp = _http_json(base + "/chat/completions", payload, headers)
        msg = resp["choices"][0]["message"]["content"]
        theme = (msg or "").strip()
        theme = theme.strip('"\'“”‘’。. `')
        theme = re.sub(r"\.[A-Za-z0-9]{1,5}$", "", theme)  # 万一带了扩展名
        if len(theme) > cfg.get("max_len", 40):
            theme = theme[:cfg.get("max_len", 40)]
        if theme:
            return theme, ""
        return None, "AI 返回内容为空"
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode("utf-8", errors="replace")[:300]
        except Exception:
            pass
        if e.code in (401, 403):
            return None, "API Key 无效或没有权限 (HTTP {})".format(e.code)
        return None, "接口返回 HTTP {}: {}".format(e.code, body or e.reason)
    except urllib.error.URLError as e:
        return None, "无法连接 {}: {}".format(base, e.reason)
    except Exception as e:
        return None, "AI 调用失败: {}".format(e)


# ---------------------------------------------------------------------------
# 顶层流程：处理单文件 / 批量规划 / 执行改名
# ---------------------------------------------------------------------------

def process_one(path, cfg, use_ai=None):
    """抽取内容 → （AI 优先）→ 本地兜底 → 返回新文件名。"""
    if use_ai is None:
        use_ai = cfg.get("ai_enabled", True)
    meta = extract_content(path)
    meta["path"] = path
    meta["name"] = os.path.basename(path)
    meta["kind"] = TYPE_NAMES.get(os.path.splitext(path)[1].lower(),
                                  meta["kind"])
    ai_theme, ai_note = None, ""
    if use_ai:
        ai_theme, ai_note = ai_summarize(meta, cfg)
    new_name = build_new_name(path, meta, cfg, ai_theme=ai_theme)
    return {
        "path": path,
        "old_name": os.path.basename(path),
        "new_name": new_name,
        "meta": meta,
        "summary": ai_theme or local_summarize(meta, meta.get("text", ""), cfg.get("lang", "zh")),
        "used_ai": bool(ai_theme),
        "note": ai_note or meta["note"],
    }


def make_plan(items, cfg, use_ai=True):
    """批量生成改名计划 {old→new}（保证新名互不冲突）。"""
    rows = [process_one(it, cfg, use_ai=use_ai) for it in items]
    used = set()
    for r in rows:
        if r["path"] is None:
            continue
        dirpath = os.path.dirname(r["path"]) or "."
        stem, ext = os.path.splitext(r["new_name"])
        target = unique_target(dirpath, stem, ext, used)
        used.add(target.lower())
        r["target"] = target
        r["new_name"] = os.path.basename(target)
    return rows


def apply_plan(rows):
    """执行改名，返回成功/失败列表。"""
    results = []
    for r in rows:
        if not r.get("target") or r.get("done"):
            continue
        try:
            os.rename(r["path"], r["target"])
            results.append((r["path"], r["target"], None))
            r["done"] = True
        except OSError as e:
            results.append((r["path"], r.get("target"), str(e)))
    return results


# ---------------------------------------------------------------------------
# 图形界面
# ---------------------------------------------------------------------------

def gui_main():
    try:
        import tkinter as tk
        from tkinter import ttk, filedialog, messagebox, simpledialog
    except ImportError as e:
        print("缺少 tkinter，无法打开图形界面：", e)
        return 1

    cfg = load_config()

    class Row:
        __slots__ = ("path", "meta", "suggested", "override", "status", "note", "info")

    class App(tk.Tk):
        def __init__(self):
            super().__init__()
            self.title("智能改名 —— 按内容总结主题，批量重命名")
            self.geometry("1060x680")
            self.minsize(860, 540)
            self.rows = []            # list[Row]
            self.queue_in = queue.Queue()   # (index, path) 待处理
            self.queue_out = queue.Queue()  # (index, rowinfo, err)
            self.worker = None
            self.undo_stack = []      # list[(old, new)]
            self._build_ui()
            self.after(80, self._poll)

        # ---------------- UI ----------------
        def _build_ui(self):
            style = ttk.Style(self)
            try:
                style.theme_use("vista")
            except Exception:
                pass
            pad = {"padx": 6, "pady": 4}

            top = ttk.Frame(self)
            top.pack(fill="x", **pad)
            ttk.Button(top, text="➕ 添加文件", command=self.add_files).pack(side="left")
            ttk.Button(top, text="📁 添加文件夹", command=self.add_folder).pack(side="left", padx=(6, 0))
            self.recursive_var = tk.BooleanVar(value=bool(cfg.get("recursive")))
            ttk.Checkbutton(top, text="含子文件夹", variable=self.recursive_var).pack(side="left", padx=(6, 0))
            ttk.Button(top, text="❌ 移除选中", command=self.remove_selected).pack(side="left", padx=(12, 0))
            ttk.Button(top, text="清空列表", command=self.clear_rows).pack(side="left", padx=(6, 0))

            ttk.Separator(self).pack(fill="x")
            mid = ttk.Frame(self)
            mid.pack(fill="x", **pad)
            ttk.Button(mid, text="✏️ 编辑新名（双击行也可以）", command=self.edit_selected_name).pack(side="left")
            ttk.Button(mid, text="↩️ 恢复建议名", command=self.restore_suggested).pack(side="left", padx=(6, 0))
            ttk.Button(mid, text="🔄 重新总结选中", command=self.reprocess_selected).pack(side="left", padx=(12, 0))
            ttk.Button(mid, text="✅ 一键改名", command=self.do_rename).pack(side="right")
            ttk.Button(mid, text="↩️ 撤销上次改名", command=self.undo_rename).pack(side="right", padx=(6, 0))
            ttk.Button(mid, text="⚙️ 设置", command=self.open_settings).pack(side="right", padx=(6, 0))

            # 文件列表
            cols_frame = ttk.Frame(self)
            cols_frame.pack(fill="both", expand=True, padx=6, pady=(0, 4))
            self.tree = ttk.Treeview(
                cols_frame, columns=("old", "new", "kind", "status"),
                show="headings", selectmode="extended",
            )
            self.tree.heading("old", text="原文件名")
            self.tree.heading("new", text="建议新文件名（双击可改）")
            self.tree.heading("kind", text="类型")
            self.tree.heading("status", text="状态")
            self.tree.column("old", width=280, anchor="w")
            self.tree.column("new", width=300, anchor="w")
            self.tree.column("kind", width=110, anchor="w")
            self.tree.column("status", width=160, anchor="w")
            vsb = ttk.Scrollbar(cols_frame, orient="vertical", command=self.tree.yview)
            hsb = ttk.Scrollbar(cols_frame, orient="horizontal", command=self.tree.xview)
            self.tree.configure(yscrollcommand=vsb.set, xscrollcommand=hsb.set)
            self.tree.grid(row=0, column=0, sticky="nsew")
            vsb.grid(row=0, column=1, sticky="ns")
            hsb.grid(row=1, column=0, sticky="ew")
            cols_frame.rowconfigure(0, weight=1)
            cols_frame.columnconfigure(0, weight=1)
            self.tree.bind("<Double-1>", self._on_double_click)
            self.tree.bind("<Delete>", lambda e: self.remove_selected())

            # 底部摘要
            bottom = ttk.LabelFrame(self, text=" 选中文件的「重点摘要」—— 根据它生成新名字 ")
            bottom.pack(fill="both", padx=6, pady=(0, 6))
            self.summary_text = tk.Text(bottom, height=6, wrap="word",
                                        font=("Microsoft YaHei UI", 9))
            self.summary_text.pack(fill="both", expand=True, padx=4, pady=4)
            self.summary_text.configure(state="disabled")

            self.status = ttk.Label(self, text="就绪：添加文件后自动分析，状态变为「就绪」即可一键改名",
                                    anchor="w")
            self.status.pack(fill="x", padx=6, pady=(0, 6))

            self.tree.tag_configure("ready", foreground="#0a6c32")
            self.tree.tag_configure("error", foreground="#b00020")
            self.tree.tag_configure("done", foreground="#555555")
            self.tree.tag_configure("ai", foreground="#7a4b12")

        # ---------------- 添加文件 ----------------
        def _collect_paths(self, paths):
            existing = {r.path.lower() for r in self.rows}
            added = []
            for p in paths:
                p = os.path.abspath(p)
                if os.path.isfile(p) and p.lower() not in existing:
                    added.append(p)
                    existing.add(p.lower())
                elif os.path.isdir(p):
                    for root, dirs, files in os.walk(p):
                        if not self.recursive_var.get():
                            dirs[:] = []
                        for fn in files:
                            fp = os.path.join(root, fn)
                            if fp.lower() in existing:
                                continue
                            # 跳过临时文件
                            if fn.startswith("~$") or fn.endswith((".tmp", ".lnk")):
                                continue
                            added.append(fp)
                            existing.add(fp.lower())
            return added

        def add_files(self):
            paths = filedialog.askopenfilenames(
                title="选择要改名的文件（可多选，各类型均可）")
            if not paths:
                return
            self._add(paths)

        def add_folder(self):
            folder = filedialog.askdirectory(title="选择文件夹（批量处理其中的文件）")
            if not folder:
                return
            self._add([folder])

        def _add(self, paths):
            added = self._collect_paths(paths)
            for p in added:
                row = Row()
                row.path = p
                row.meta = None
                row.suggested = ""
                row.override = ""
                row.status = "排队分析…"
                row.note = ""
                row.info = "（待分析）"
                self.rows.append(row)
                self.queue_in.put((len(self.rows) - 1, p))
            self._refresh_tree()
            if self.worker is None or not self.worker.is_alive():
                self.worker = threading.Thread(target=self._worker_loop, daemon=True)
                self.worker.start()

        # ---------------- 后台分析 ----------------
        def _worker_loop(self):
            while True:
                try:
                    idx, path = self.queue_in.get(timeout=0.5)
                except queue.Empty:
                    if self.queue_out.empty():
                        time.sleep(0.2)
                    continue
                try:
                    row_info = process_one(path, cfg)
                    self.queue_out.put((idx, row_info, None))
                except Exception as e:
                    self.queue_out.put((idx, None, "分析失败: {} — {}".format(e, traceback.format_exc()[-400:])))
                finally:
                    self.queue_in.task_done()

        def _poll(self):
            try:
                while True:
                    idx, info, err = self.queue_out.get_nowait()
                    row = self.rows[idx]
                    if err:
                        row.status = err.splitlines()[0][:60]
                        row.note = err
                    else:
                        row.meta = info
                        row.suggested = info["new_name"]
                        row.override = ""
                        row.status = "就绪" + ("（AI）" if info["used_ai"] else "（本地）")
                        row.note = info["note"]
                        row.info = info
                    self._refresh_tree()
            except queue.Empty:
                pass
            self.after(80, self._poll)

        # ---------------- 列表操作 ----------------
        def _row_index(self, iid):
            return int(iid)

        def _refresh_tree(self):
            self.tree.delete(*self.tree.get_children())
            ai_used = 0
            for i, row in enumerate(self.rows):
                shown = row.override or row.suggested
                kind = row.meta["meta"]["kind"] if row.meta else ""
                tags = []
                if row.status.startswith("就绪"):
                    tags.append("ai" if "（AI）" in row.status else "ready")
                    if row.override:
                        tags.append("ready")
                elif row.status.startswith("已改名"):
                    tags.append("done")
                elif row.status.startswith(("失败", "分析失败")):
                    tags.append("error")
                self.tree.insert("", "end", iid=str(i),
                                 values=(os.path.basename(row.path), shown or "…", kind, row.status),
                                 tags=tags)
                if "（AI）" in row.status:
                    ai_used += 1
            self.status.config(
                text="共 {} 个文件，AI 总结 {} 个，本地兜底 {} 个；就绪 {} 个 → 可点「一键改名」。双击某行可手动改新名。".format(
                    len(self.rows), ai_used,
                    sum(1 for r in self.rows if r.status.startswith("就绪")) - ai_used,
                    sum(1 for r in self.rows if r.status.startswith("就绪"))))

        def _on_double_click(self, event):
            iid = self.tree.identify_row(event.y)
            col = self.tree.identify_column(event.x)
            if not iid or col != "#2":
                return
            self._edit_name(iid)

        def edit_selected_name(self):
            sel = self.tree.selection()
            if not sel:
                messagebox.showinfo("提示", "请先在列表里选中一行（可多选）", parent=self)
                return
            if len(sel) > 1:
                name = simpledialog.askstring(
                    "批量改新名", "为选中的 {} 个文件统一设置新名（可留空恢复自动建议；\n同名冲突会自动加序号）："
                    .format(len(sel)), parent=self)
                if name is None:
                    return
                for iid in sel:
                    row = self.rows[int(iid)]
                    row.override = sanitize_name(name) if name.strip() else ""
                self._refresh_tree()
                return
            self._edit_name(sel[0])

        def _edit_name(self, iid):
            row = self.rows[int(iid)]
            dlg = tk.Toplevel(self)
            dlg.title("编辑新文件名")
            dlg.geometry("460x110")
            dlg.transient(self)
            dlg.grab_set()
            ttk.Label(dlg, text="新文件名（不含扩展名；留空 = 恢复自动建议）").pack(pady=(10, 4))
            var = tk.StringVar(value=row.override or os.path.splitext(row.suggested)[0])
            entry = ttk.Entry(dlg, textvariable=var, width=60)
            entry.pack(padx=10)
            entry.focus_set()
            entry.select_range(0, "end")

            def ok():
                val = var.get().strip()
                row.override = sanitize_name(val, cfg.get("max_len", 40)) if val else ""
                dlg.destroy()
                self._refresh_tree()

            btns = ttk.Frame(dlg)
            btns.pack(pady=8)
            ttk.Button(btns, text="确定", command=ok).pack(side="left")
            ttk.Button(btns, text="取消", command=dlg.destroy).pack(side="left", padx=8)
            entry.bind("<Return>", lambda e: ok())

        def restore_suggested(self):
            for iid in self.tree.selection():
                row = self.rows[int(iid)]
                if row.suggested:
                    row.override = ""
            self._refresh_tree()

        def reprocess_selected(self):
            sel = self.tree.selection()
            if not sel:
                messagebox.showinfo("提示", "请先选中要重新分析的文件", parent=self)
                return
            for iid in sel:
                idx = int(iid)
                row = self.rows[idx]
                row.status = "排队分析…"
                row.meta = None
                row.suggested = ""
                self.queue_in.put((idx, row.path))
            self._refresh_tree()
            if self.worker is None or not self.worker.is_alive():
                self.worker = threading.Thread(target=self._worker_loop, daemon=True)
                self.worker.start()

        def remove_selected(self):
            for iid in sorted(self.tree.selection(), key=int, reverse=True):
                del self.rows[int(iid)]
            self._refresh_tree()

        def clear_rows(self):
            if self.rows and messagebox.askyesno("确认", "清空整个列表？", parent=self):
                self.rows = []
                self._refresh_tree()

        # ---------------- 改名 / 撤销 ----------------
        def do_rename(self):
            ready = [r for r in self.rows
                     if r.status.startswith("就绪") and r.suggested and not r.meta is None]
            if not ready:
                messagebox.showinfo("提示", "还没有可改名的文件（请等状态变为「就绪」）", parent=self)
                return
            plan = []
            for r in ready:
                name = r.override or r.suggested
                stem, ext = os.path.splitext(name)
                plan.append((r, os.path.join(os.path.dirname(r.path), stem + ext)))
            # 批内去重
            used = set()
            final = []
            for r, target in plan:
                stem, ext = os.path.splitext(os.path.basename(target))
                final.append((r, unique_target(os.path.dirname(r.path), stem, ext, used)))
                used.add(final[-1][1].lower())
            # 预览
            preview = "\n".join("{}  →  {}".format(os.path.basename(r.path), os.path.basename(t))
                                for r, t in final[:60])
            if len(final) > 60:
                preview += "\n… 共 {} 个".format(len(final))
            if not messagebox.askyesno("确认改名", "将重命名 {} 个文件：\n\n{}".format(len(final), preview), parent=self):
                return
            ok_count, fail_list = 0, []
            for r, target in final:
                try:
                    os.rename(r.path, target)
                    self.undo_stack.append((r.path, target))
                    r.path = target
                    r.status = "已改名 ✓"
                    r.suggested = ""
                    r.override = ""
                    ok_count += 1
                except OSError as e:
                    fail_list.append("{}：{}".format(os.path.basename(r.path), e))
            self._refresh_tree()
            msg = "成功改名 {} 个文件".format(ok_count)
            if fail_list:
                msg += "\n\n{} 个失败：\n{}".format(len(fail_list), "\n".join(fail_list[:10]))
            elif self.undo_stack:
                msg += "\n（可点「撤销上次改名」恢复）"
            messagebox.showinfo("完成", msg, parent=self)

        def undo_rename(self):
            if not self.undo_stack:
                messagebox.showinfo("提示", "没有可撤销的改名记录", parent=self)
                return
            ok, fail = 0, []
            for old, new in reversed(self.undo_stack):
                try:
                    os.rename(new, old)
                    ok += 1
                except OSError as e:
                    fail.append("{}：{}".format(os.path.basename(new), e))
            self.undo_stack = []
            for r in self.rows:
                if r.status.startswith("已改名"):
                    r.status = "就绪（已恢复原名）"
            self._refresh_tree()
            messagebox.showinfo("撤销", "已恢复 {} 个文件{}".format(
                ok, "；失败 {} 个:\n{}".format(len(fail), "\n".join(fail[:8])) if fail else ""), parent=self)

        # ---------------- 设置 ----------------
        def open_settings(self):
            dlg = tk.Toplevel(self)
            dlg.title("设置 — 主题总结方式")
            dlg.geometry("520x430")
            dlg.transient(self)
            dlg.grab_set()

            ai_var = tk.BooleanVar(value=bool(cfg.get("ai_enabled")))
            url_var = tk.StringVar(value=cfg.get("base_url", ""))
            key_var = tk.StringVar(value=cfg.get("api_key", ""))
            model_var = tk.StringVar(value=cfg.get("model", ""))
            lang_var = tk.StringVar(value="中文" if cfg.get("lang") == "zh" else "English")
            len_var = tk.IntVar(value=int(cfg.get("max_len", 40)))
            date_var = tk.BooleanVar(value=bool(cfg.get("with_date", True)))
            vis_var = tk.BooleanVar(value=bool(cfg.get("vision", True)))

            f = ttk.Frame(dlg, padding=12)
            f.pack(fill="both", expand=True)
            ttk.Checkbutton(f, text="优先使用 AI 总结（未配置或调用失败时自动用本地分析兜底）",
                            variable=ai_var).grid(row=0, column=0, columnspan=2, sticky="w", pady=(0, 8))

            ttk.Label(f, text="API 地址 (OpenAI 兼容)").grid(row=1, column=0, sticky="w", pady=3)
            ttk.Entry(f, textvariable=url_var, width=52).grid(row=1, column=1, sticky="ew", pady=3)
            ttk.Label(f, text="API Key").grid(row=2, column=0, sticky="w", pady=3)
            ttk.Entry(f, textvariable=key_var, width=52, show="*").grid(row=2, column=1, sticky="ew", pady=3)
            ttk.Label(f, text="模型").grid(row=3, column=0, sticky="w", pady=3)
            ttk.Entry(f, textvariable=model_var, width=52).grid(row=3, column=1, sticky="ew", pady=3)

            ttk.Label(f, text="名字语言").grid(row=4, column=0, sticky="w", pady=3)
            ttk.Combobox(f, textvariable=lang_var, values=("中文", "English"), state="readonly", width=12
                         ).grid(row=4, column=1, sticky="w", pady=3)
            ttk.Label(f, text="名字最大长度").grid(row=5, column=0, sticky="w", pady=3)
            ttk.Spinbox(f, from_=10, to=80, textvariable=len_var, width=8).grid(row=5, column=1, sticky="w", pady=3)
            ttk.Checkbutton(f, text="新名字前面带上日期（正文/拍摄时间/修改时间）",
                            variable=date_var).grid(row=6, column=0, columnspan=2, sticky="w", pady=3)
            ttk.Checkbutton(f, text="图片用 AI 视觉识别内容（需模型支持看图）",
                            variable=vis_var).grid(row=7, column=0, columnspan=2, sticky="w", pady=3)

            tip = ("常见配置：\n"
                   "• DeepSeek: https://api.deepseek.com/v1 ，模型 deepseek-chat（不支持看图）\n"
                   "• OpenAI: https://api.openai.com/v1 ，模型 gpt-4o-mini（支持看图）\n"
                   "• 本地 Ollama: http://127.0.0.1:11434/v1 ，模型 qwen2.5-vl:7b 等\n"
                   "• 硅基流动: https://api.siliconflow.cn/v1 ，模型 Qwen/Qwen2.5-VL-7B-Instruct\n"
                   "不填 Key 时自动用本地关键词分析，完全离线可用。")
            ttk.Label(f, text=tip, justify="left", foreground="#555").grid(
                row=8, column=0, columnspan=2, sticky="w", pady=(10, 4))

            def ok():
                cfg["ai_enabled"] = ai_var.get()
                cfg["base_url"] = url_var.get().strip()
                cfg["api_key"] = key_var.get().strip()
                cfg["model"] = model_var.get().strip() or "gpt-4o-mini"
                cfg["lang"] = "zh" if lang_var.get() == "中文" else "en"
                cfg["max_len"] = max(10, min(80, len_var.get()))
                cfg["with_date"] = date_var.get()
                cfg["vision"] = vis_var.get()
                cfg["recursive"] = bool(self.recursive_var.get())
                save_config(cfg)
                dlg.destroy()

            btns = ttk.Frame(dlg)
            btns.pack(pady=(0, 10))
            ttk.Button(btns, text="保存", command=ok).pack(side="left")
            ttk.Button(btns, text="取消", command=dlg.destroy).pack(side="left", padx=8)
            f.columnconfigure(1, weight=1)

        # ---------------- 摘要显示 ----------------
        def _show_summary(self, event=None):
            sel = self.tree.selection()
            if not sel:
                return
            row = self.rows[int(sel[0])]
            self.summary_text.configure(state="normal")
            self.summary_text.delete("1.0", "end")
            if row.meta:
                info = row.meta
                m = info["meta"]
                lines = ["主题：{}".format(info["summary"])]
                if row.override:
                    lines.append("手动新名：{}（自动建议：{}）".format(row.override, info["new_name"]))
                if info["used_ai"]:
                    lines.append("来源：AI 总结")
                lines.append("类型：{}".format(m.get("kind", "")))
                if m.get("text"):
                    t = m["text"].strip().replace("\n", " ")
                    lines.append("内容摘录：{}…".format(t[:220]))
                if info["note"]:
                    lines.append("备注：{}".format(info["note"]))
                self.summary_text.insert("1.0", "\n".join(lines))
            else:
                self.summary_text.insert("1.0", "（分析中…）")
            self.summary_text.configure(state="disabled")

    app = App()
    app.tree.bind("<<TreeviewSelect>>", app._show_summary)
    # 命令行带路径时（python smart_renamer.py a.txt 文件夹/…）启动即加入列表
    init_paths = [a for a in sys.argv[1:] if not a.startswith("--")
                  and os.path.exists(a)]
    if init_paths:
        app._add(init_paths)
    app.mainloop()
    return 0


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------

def main():
    # Windows 控制台默认 GBK，切到 UTF-8 避免打印中文/特殊符号报错
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    args = sys.argv[1:]
    if "--selftest" in args:
        return selftest()
    if "--version" in args:
        print("smart_renamer 1.0")
        return 0
    return gui_main()


def selftest():
    print("=== 自检模式（不弹界面）===")
    import tempfile
    tmp = tempfile.mkdtemp(prefix="smart_renamer_self_")
    sample = os.path.join(tmp, "2025年1月会议记录.txt")
    with open(sample, "w", encoding="utf-8") as f:
        f.write("会议纪要\n主题：2025年一季度市场部工作安排\n参会人：张伟、李娜、王强\n"
                "讨论销售数据增长和客户名单更新，制定下季度工作计划\n")
    info = process_one(sample, {**DEFAULT_CONFIG, "ai_enabled": False})
    print("原文件:", info["old_name"])
    print("新名字:", info["new_name"])
    if "会议纪要" not in info["new_name"]:
        print("✗ 自检失败：未识别出文档类型")
        return 1
    print("✓ 自检通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())