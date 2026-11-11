// worker.js —— smart-renamer 云端版（零依赖，可直接通过 Cloudflare API 部署）
// 浏览器上传文件 → 抽取内容 → （可选 Workers AI）总结主题 → 返回建议新名
// 前端在浏览器本地用新文件名下载（正文不出下载流程、不落云端）。
// 部署后访问：https://<script名>.<子域>.workers.dev/

const COMPAT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const VISION_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct"; // 视觉识别（OCR 能力远超 llava）
const VISION_MAX_BYTES = 2 * 1024 * 1024;                       // 超过 2MB 的图不送视觉（data URL 会膨胀）

// ---------------------------------------------------------------------------
// 类型 / 关键词 / 日期 / 命名（本地兜底，与桌面版同思路）
// ---------------------------------------------------------------------------

const TEXT_EXTS = new Set([
  "txt", "md", "markdown", "log", "csv", "tsv", "json", "yaml", "yml", "xml",
  "ini", "cfg", "conf", "html", "htm", "css", "js", "jsx", "ts", "tsx", "py",
  "java", "c", "cpp", "h", "hpp", "cs", "go", "rs", "php", "rb", "sql", "sh",
  "bat", "ps1", "vbs", "rtf", "srt", "vtt", "toml", "properties", "tex", "bib",
  "env", "txt",
]);
const IMG_EXTS = new Set(["jpg", "jpeg", "png", "webp", "bmp", "gif", "tiff", "tif"]);
const OFFICE_EXTS = new Set(["docx", "pptx", "xlsx", "xlsm"]);
const TYPE_NAMES = {
  txt: "文本", md: "Markdown", log: "日志", csv: "表格数据", json: "数据",
  html: "网页", docx: "Word 文档", xlsx: "Excel 表格", pptx: "PPT 演示",
  pdf: "PDF 文档", jpg: "图片", jpeg: "图片", png: "图片", webp: "图片",
  doc: "Word(旧)", xls: "Excel(旧)", ppt: "PPT(旧)", fig: "文件",
};

const DOC_TYPES = [
  ["会议纪要|会谈纪要|纪要", "会议纪要"],
  ["通知|公告|告示", "通知公告"],
  ["销售(数据|报表|分析|统计|额)", "销售数据"],
  ["数据分析|统计报表|统计表|数据报表|指标", "数据分析"],
  ["合同(书)?|协议书?|补充协议|框架(协议|合同)", "合同协议"],
  ["招标|投标|标书", "标书"],
  ["预算|决算|报销|发票|账目|台账|对账单", "财务"],
  ["客户|联系人|通讯录|人员名单|花名册|客户名单", "名单"],
  ["简历|求职|应聘|面试", "简历"],
  ["工作总结|小结|季度总结|年度总结", "总结"],
  ["工作计划|工作安排|排期|计划表|行事历", "工作计划"],
  ["培训|教程|课件|讲义|手册|指南", "教程手册"],
  ["方案|策划|提案", "方案"],
  ["制度|规定|规范|条例|章程|办法", "制度规范"],
  ["申请书|申请表|审批表|备案表", "申请表单"],
  ["行程|日程|时间表|会议安排|排期表", "日程安排"],
  ["请假|调休|考勤|排班", "考勤"],
  ["测试|用例|缺陷|bug|BUG", "测试"],
  ["需求文档|PRD|产品需求", "需求文档"],
  ["设计稿|效果图|原型", "设计稿"],
  ["日报|周报|月报|工作报告", "工作报告"],
  ["发布会|路演", "发布会"],
  ["笔记|心得|摘录|读书", "笔记"],
  ["邀请函|请柬", "邀请函"],
  ["贺卡|祝福|致辞|发言稿", "致辞贺卡"],
  ["总结", "总结"],
  ["清单|明细|目录", "清单"],
  ["记录|日志", "记录"],
];

const STOP_EN = new Set("the,and,for,with,from,this,that,are,was,were,have,has,had,not,but,you,your,our,their,they,them,will,would,can,could,should,all,any,each,its,into,about,than,then,there,these,those,upon,also,been,being,what,when,where,which,who,whom,how,why,though,just,very,more,most,some,such,only,own,same,so,too,well,one,two,new,file,data,info".split(","));

function findDocType(text) {
  for (const [pat, label] of DOC_TYPES) {
    if (new RegExp(pat).test(text)) return label;
  }
  return "";
}

function topKeywords(text, n = 2) {
  const out = [];
  // 英文单词
  const en = (text.match(/[A-Za-z][A-Za-z0-9_]{2,}/g) || [])
    .map(w => w.toLowerCase()).filter(w => !STOP_EN.has(w) && !/^\d+$/.test(w));
  const freq = {};
  en.forEach(w => { freq[w] = (freq[w] || 0) + 1; });
  const enTop = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 2).map(e => e[0]);
  // 中文：2 字滑窗词频（无分词库的折中），过滤含虚词的碎片；只取最高频 1 个
  const NOISE = new Set("的了与及在为对由等和第个一不也是就都而或且之其很到把被让这那于乎从向以并还又再已做作所因被可会要紧能限公".split(""));
  const zh = (text.match(/[\u4e00-\u9fff]{2,}/g) || []).join("");
  const zhTop = [];
  if (zh.length) {
    const zf = {};
    for (let i = 0; i < zh.length - 1; i++) {
      const g = zh.slice(i, i + 2);
      if ([...g].some(c => NOISE.has(c))) continue;
      zf[g] = (zf[g] || 0) + 1;
    }
    const top = Object.entries(zf).sort((a, b) => b[1] - a[1]).slice(0, 1).map(e => e[0]);
    zhTop.push(...top);
  }
  return [...enTop, ...zhTop].slice(0, n);
}

function findHeading(text) {
  if (!text) return "";
  for (const line of text.split("\n").slice(0, 30)) {
    const t = line.trim().replace(/^#[#\s]*/, "").trim();
    if (!t || t.length > 20) continue;
    if (/[，。；！？、:：,;|/]/.test(t)) continue;
    if (/^\d{1,2}[.、-]/.test(t)) continue;
    return t;
  }
  return "";
}

function findDate(text = "", name = "", meta = {}) {
  let t = text || "";
  let m;
  m = t.match(/(20\d{2})年\s*(\d{1,2})月(?:\s*(\d{1,2})日?)?/);
  if (m) return m[3] ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : `${m[1]}年${m[2]}月`;
  m = t.match(/(20\d{2})年[^。\n;；]{0,12}?([一二三四1-4])季度/);
  if (m) return `${m[1]}-Q${"一二三四".indexOf(m[2]) >= 0 ? "一二三四".indexOf(m[2]) + 1 : m[2]}`;
  m = t.match(/(20\d{2})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = name.match(/(20\d{2})[-_.]?(\d{2})[-_.]?(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/(20\d{2})年/);
  if (m) return `${m[1]}年`;
  if (meta.shotTime) return meta.shotTime.slice(0, 10);
  return "";
}

function sanitize(name, maxLen) {
  let s = String(name || "").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").trim().replace(/\s+/g, " ").replace(/__+/g, "_");
  s = s.replace(/^\.+|\.+$/g, "");
  if (!s) s = "未命名";
  if (maxLen && s.length > maxLen) s = s.slice(0, maxLen).replace(/[ _.-]+$/, "");
  return s;
}

function proposeName(meta) {
  // meta: { name, kind, text, shotTime }。只返回「主题」，日期由调用方拼。
  const docType = findDocType(meta.text || "");
  let kw = topKeywords(meta.text || "", 2);
  // 有明确文档类型时：只接受英文词 / 3 字以上中文词作补充，拒绝 2 字滑窗碎片
  if (docType) kw = kw.filter(w => /[A-Za-z]/.test(w) || w.length >= 3);
  kw = kw.filter(w => !docType || !docType.includes(w));  // 避免与文档类型重复
  const heading = findHeading(meta.text || "");
  const parts = [];
  if (docType) parts.push(docType);
  if (kw.length) parts.push(...kw);
  if (!parts.length && heading && (docType ? !docType.includes(heading) : true)) parts.push(heading.slice(0, 12));
  if (!parts.length) {
    parts.push((IMG_EXTS.has(meta.ext) ? "照片" : "资料"));
  }
  return sanitize(parts.join(" "), 30);
}

// ---------------------------------------------------------------------------
// ZIP 解析（手写，零依赖；deflate 用 Compression Streams）
// ---------------------------------------------------------------------------

async function inflateRaw(buf) {
  // ZIP method8 = raw deflate (RFC1951)。优先 deflate-raw，退回 deflate（zlib 头）
  for (const fmt of ["deflate-raw", "deflate"]) {
    try {
      const ds = new DecompressionStream(fmt);
      const stream = new Blob([buf]).stream().pipeThrough(ds);
      const ab = await new Response(stream).arrayBuffer();
      if (ab.byteLength) return ab;
    } catch (e) { /* 尝试下一个 */ }
  }
  return null;
}

export async function parseZip(buf) {
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  const len = u8.length;
  // 找 EOCD（PK\x05\x06），最多回退 65536+22
  let eocd = -1;
  for (let i = len - 22; i >= Math.max(0, len - 22 - 65566); i--) {
    if (u8[i] === 0x50 && u8[i + 1] === 0x4b && u8[i + 2] === 0x05 && u8[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = dv.getUint16(eocd + 10, true);
  const cdOff = dv.getUint32(eocd + 16, true);
  const entries = [];
  let p = cdOff;
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const nameBytes = u8.slice(p + 46, p + 46 + nameLen);
    const name = new TextDecoder().decode(nameBytes);
    // 定位 local header 数据区
    let dataStart = -1;
    if (dv.getUint32(localOff, true) === 0x04034b50) {
      const ln = dv.getUint16(localOff + 26, true);
      const en = dv.getUint16(localOff + 28, true);
      dataStart = localOff + 30 + ln + en;
    }
    if (dataStart >= 0) {
      let data = buf.slice(dataStart, dataStart + compSize);
      if (method === 8 && compSize > 0) {
        const raw = await inflateRaw(data);
        if (raw) data = raw;
      }
      if (!name.endsWith("/")) entries.push({ name, data, method });
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function xmlText(xml, tagRe) {
  return [...xml.matchAll(tagRe)].map(m => decodeXml(m[1])).filter(Boolean);
}

function decodeXml(s) {
  if (!s) return "";
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

// ---------------------------------------------------------------------------
// 各类文件抽取
// ---------------------------------------------------------------------------

async function extractTextLike(buf) {
  // 先按 UTF-8 严格解码，失败则 GBK（Windows 常见编码，浏览器/Workers 均支持）
  const u8 = new Uint8Array(buf);
  try { return new TextDecoder("utf-8", { fatal: true }).decode(u8); }
  catch (e) { try { return new TextDecoder("gbk").decode(u8); } catch (e2) { return new TextDecoder().decode(u8); } }
}

async function extractOffice(entries, ext) {
  if (ext === "docx") {
    const doc = entries.find(e => e.name === "word/document.xml");
    if (!doc) return "";
    const xml = new TextDecoder().decode(doc.data);
    // 按段落分组取文本
    const paras = xml.split(/<w:p\b[^>]*>/).slice(1).map(p => {
      const t = xmlText(p, /<w:t[^>]*>([^<]*)<\/w:t>/g).join("");
      return t.trim();
    }).filter(Boolean);
    return paras.join("\n").slice(0, 6000);
  }
  if (ext === "pptx") {
    const slides = entries.filter(e => /^ppt\/slides\/slide\d+\.xml$/.test(e.name))
      .sort((a, b) => (a.name.match(/\d+/) || 0) - (b.name.match(/\d+/) || 0)).slice(0, 8);
    const lines = [];
    for (const s of slides) {
      const xml = new TextDecoder().decode(s.data);
      const t = xmlText(xml, /<a:t[^>]*>([^<]*)<\/a:t>/g).filter(x => x.trim()).join(" / ");
      if (t) lines.push("[页] " + t);
    }
    return lines.join("\n").slice(0, 6000);
  }
  if (ext === "xlsx" || ext === "xlsm") {
    const sst = entries.find(e => e.name === "xl/sharedStrings.xml");
    const shared = sst ? xmlText(new TextDecoder().decode(sst.data), /<t[^>]*>([^<]*)<\/t>/g) : [];
    const sheet = entries.find(e => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name));
    if (!sheet) return "";
    const xml = new TextDecoder().decode(sheet.data);
    const rows = [];
    const rowRe = /<row\b[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
    let m;
    let n = 0;
    while ((m = rowRe.exec(xml)) && n < 6) {
      n++;
      const cells = [];
      const cRe = /<c\b([^>]*)>([\s\S]*?)<\/c>/g;
      let cm;
      while ((cm = cRe.exec(m[2]))) {
        const attrs = cm[1] || "";
        const inner = cm[2] || "";
        const tAttr = (attrs.match(/t="(\w+)"/) || [])[1] || "";
        let val = "";
        if (tAttr === "inlineStr") {
          // 字符串内联：<c t="inlineStr"><is><t>…</t></is></c>
          val = decodeXml((inner.match(/<t[^>]*>([^<]*)<\/t>/) || [])[1] || "");
        } else if (tAttr === "s") {
          const v = (inner.match(/<v>([^<]*)<\/v>/) || [])[1] || "";
          val = shared[+v] || "";
        } else {
          val = decodeXml((inner.match(/<v>([^<]*)<\/v>/) || [])[1] || "");
        }
        cells.push(val.trim());
      }
      rows.push(cells.filter(Boolean).join(" | "));
    }
    return rows.join("\n").slice(0, 6000);
  }
  return "";
}

function parseJpegExif(buf) {
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  if (u8[0] !== 0xff || u8[1] !== 0xd8) return null;
  let p = 2;
  const meta = {};
  while (p + 4 <= u8.length) {
    if (u8[p] !== 0xff) { p++; continue; }
    const marker = u8[p + 1];
    if (marker === 0xd9 || marker === 0xda) break;
    const segLen = dv.getUint16(p + 2, false);
    if (marker === 0xe1 && segLen > 8 &&
        u8[p + 4] === 0x45 && u8[p + 5] === 0x78 && u8[p + 6] === 0x69 && u8[p + 7] === 0x66) {
      // TIFF header 在 p+10
      const t = p + 10;
      const endian = dv.getUint16(t, false) === 0x4949 ? true : false; // true = little
      const magic = dv.getUint16(t + 2, endian);
      if (magic !== 0x2a) return meta;
      const ifd0 = dv.getUint32(t + 4, endian);
      const tag = (off) => dv.getUint16(t + off, endian);
      const val = (off) => dv.getUint32(t + off, endian);
      const readIfd = (ifdOff, wantExif) => {
        const n = dv.getUint16(t + ifdOff, endian);
        for (let i = 0; i < n; i++) {
          const e = t + ifdOff + 2 + i * 12;
          const tg = tag(e);
          const typ = dv.getUint16(e + 2, endian);
          const cnt = dv.getUint32(e + 4, endian);
          const vOfs = e + 8;
          const readStr = () => {
            const bytes = [];
            const off = typ === 2 && cnt > 4 ? val(vOfs) : vOfs;
            for (let k = 0; k < cnt; k++) bytes.push(u8[t + off + k]);
            return new TextDecoder().decode(Uint8Array.from(bytes)).replace(/\0/g, "").trim();
          };
          if (tg === 0x0132 && typ === 2) meta.dateTime = readStr();
          if (tg === 0x010f && typ === 2) meta.make = readStr();
          if (tg === 0x0110 && typ === 2) meta.model = readStr();
          if (tg === 0x8769) { const sub = val(vOfs); readIfd(sub, true); }
          if (wantExif && tg === 0x9003 && typ === 2) meta.shotTime = readStr();
        }
      };
      readIfd(ifd0, false);
      meta.shotTime = meta.shotTime || meta.dateTime;
      return meta;
    }
    if (segLen < 2) break;
    p += 2 + segLen;
  }
  return meta;
}

function extractImgMeta(buf, ext) {
  const meta = {};
  if (ext === "jpg" || ext === "jpeg") {
    try { Object.assign(meta, parseJpegExif(buf) || {}); } catch (e) {}
  } else if (ext === "png" || ext === "webp" || ext === "tiff" || ext === "tif") {
    // PNG/webp 的拍摄时间较难无库解析，跳过（视觉模型会兜底内容识别）
  }
  return meta;
}

function bufToDataUrl(buf, mime) {
  // 分块转 base64：不用展开运算符（大图会栈溢出）；块长必须是 3 的倍数，
  // 否则每块产生填充符 '='，拼接出的 base64 损坏（模型解码报 400）。
  const u8 = new Uint8Array(buf);
  const CH = 0x6000;   // 24576 = 3 * 8192
  let b64 = "";
  for (let i = 0; i < u8.length; i += CH) {
    b64 += btoa(String.fromCharCode.apply(null, u8.subarray(i, i + CH)));
  }
  return `data:${mime};base64,${b64}`;
}

function imgNote(buf) {
  if (!buf || buf.byteLength <= 0) return "图片内容为空";
  if (buf.byteLength > VISION_MAX_BYTES) {
    return `图片超过 ${(VISION_MAX_BYTES / 1024 / 1024).toFixed(0)}MB，跳过视觉识别，按日期+类型命名`;
  }
  return "";  // 正常：交给视觉模型识别画面
}

// ---------------------------------------------------------------------------
// AI 总结（Workers AI，REST 方式；失败自动本地兜底）
// ---------------------------------------------------------------------------

async function runAI(env, model, payload) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/run/${model}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Authorization": "Bearer " + env.CF_API_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) throw new Error("AI HTTP " + resp.status);
  const data = await resp.json();
  const out = data?.result || {};
  // llama-4 等文本模型返回 choices[0].message.content；llava 返回 description；其它兼容 response
  const text = String(
    out.response ??
    out.description ??
    out.choices?.[0]?.message?.content ??
    ""
  ).trim();
  if (!text) throw new Error("AI empty");
  return text;
}

async function aiSummarize(env, info, buf) {
  if (!env || !env.CF_API_TOKEN) throw new Error("no ai token");
  const isImg = IMG_EXTS.has(info.ext);
  let user = `文件类型: ${info.kind}\n文件名: ${info.name}`;
  if (info.shotTime) user += `\n拍摄时间: ${info.shotTime}`;
  if (info.metaText) user += `\n拍摄设备: ${info.metaText}`;

  if (isImg && buf && buf.byteLength <= VISION_MAX_BYTES) {
    // 视觉识别（Llama 4 Scout）：有文字→按文字出主题；无文字→按画面出主题
    const mime = (info.ext === "jpg" || info.ext === "jpeg") ? "image/jpeg"
      : info.ext === "png" ? "image/png"
      : info.ext === "webp" ? "image/webp" : "image/jpeg";
    const dataUrl = bufToDataUrl(buf, mime);
    const sys = "你是文件整理助手，负责给图片文件起一个简短贴切的中文主题名（用于重命名文件）。判断规则：一、如果图片里有文字（标题、正文、数字、日期等），先逐字读出文字，然后【优先依据文字内容】给出主题名（例如「2025年第三季度财务预算审批表」「产品发布会议程」）；二、如果图片里没有任何文字，再依据画面内容给出主题名（例如「公司年会舞台合影」「西湖断桥黄昏」）。要求：只输出主题名本身（不含扩展名、引号、解释、句号），中文 2~20 个字。";
    const theme = await runAI(env, VISION_MODEL, {
      messages: [
        { role: "system", content: sys },
        { role: "user", content: [
          { type: "text", text: (info.shotTime ? `拍摄时间: ${info.shotTime}\n` : "") + "请给这张图片起主题名。" },
          { type: "image_url", image_url: { url: dataUrl } },
        ]},
      ],
      max_tokens: 120,
    });
    return theme.replace(/^["'“”‘’.。\s]+|["'“”‘’\s]+$/g, "").split(/[。.\n]/)[0].trim();
  }

  // 文本 / Office / 超限图片：直接文本模型
  const sys = isImg
    ? "你是文件整理助手。根据用户给出的图片元信息，为图片文件提炼简短中文主题名。规则：只输出文件名主体（不含扩展名、引号、解释），中文 2~20 个字。"
    : "你是文件整理助手。根据用户给出的文件内容/元信息，提炼一个简短贴切的主题，用于重命名文件。规则：只输出文件名主体（不含扩展名、引号、解释），中文 2~18 个字；内容有明确日期/季度可带上，如「2025年第三季度 销售数据分析」。";
  if (!isImg) user += `\n内容摘录:\n${(info.text || "(正文无法读取)").slice(0, 2500)}`;
  const theme = await runAI(env, COMPAT_MODEL, {
    messages: [
      { role: "system", content: sys },
      { role: "user", content: user },
    ],
    max_tokens: 60,
    temperature: 0.3,
  });
  return theme.replace(/^["'“”‘’.。\s]+|["'“”‘’\s]+$/g, "").split("\n")[0].trim();
}

// ---------------------------------------------------------------------------
// PDF 文本提取（零依赖：对象扫描 + Flate 解压 + Tj/TJ + ToUnicode CMap）
// ---------------------------------------------------------------------------

// 字节直通转字符串。注意：TextDecoder("latin1") 实际是 windows-1252，
// 会改写 0x80-0x9F 区间的字节（如 0x9c），破坏二进制流，绝不能用于 PDF。
function bufToLatin1(input) {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  const CH = 16384;
  let s = "";
  for (let i = 0; i < u8.length; i += CH) {
    const end = Math.min(i + CH, u8.length);
    const tmp = new Array(end - i);
    for (let j = i; j < end; j++) tmp[j - i] = String.fromCharCode(u8[j]);
    s += tmp.join("");
  }
  return s;
}

function parsePdfObjects(str, limit = 1500) {
  const objs = new Map();
  const re = /(\d+)\s+\d+\s+obj\s*([\s\S]*?)(?:stream\r?\n([\s\S]*?)endstream|endobj)/g;
  let m;
  while ((m = re.exec(str)) && objs.size < limit) {
    const id = m[1];
    let dict = m[2];
    let stream = null;
    if (m[3] !== undefined) {
      stream = m[3].replace(/[\r\n]+$/, "");
      dict = dict.replace(/stream\s*$/i, "");
    }
    objs.set(id, { dict, stream });
  }
  return objs;
}

function pdfUnescape(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && i + 1 < s.length) {
      const n = s[i + 1];
      if (n === "(" || n === ")" || n === "\\") out += n;
      else if (n === "n") out += "\n";
      else if (n === "r") out += "\r";
      else if (n === "t") out += "\t";
      else if (n >= "0" && n <= "7") {
        let oct = n, k = 1;
        while (k < 3 && i + 1 + k < s.length && s[i + 1 + k] >= "0" && s[i + 1 + k] <= "7") { oct += s[i + 1 + k]; k++; }
        out += String.fromCharCode(parseInt(oct, 8));
        i += k - 1;
      } else out += n;
      i++;
    } else out += c;
  }
  return out;
}

function hexToText(h) {
  const bytes = [];
  for (let i = 0; i + 1 < h.length; i += 2) bytes.push(parseInt(h.slice(i, i + 2), 16));
  let out = "", i = 0;
  while (i + 1 < bytes.length) {
    const v = (bytes[i] << 8) | bytes[i + 1];
    if (v >= 0xd800 && v <= 0xdbff && i + 3 < bytes.length) {
      const v2 = (bytes[i + 2] << 8) | bytes[i + 3];
      out += String.fromCodePoint(0x10000 + ((v - 0xd800) << 10) + (v2 - 0xdc00));
      i += 4;
    } else { out += String.fromCodePoint(v); i += 2; }
  }
  return out;
}

function parseCmap(txt) {
  const map = new Map();
  let re = /beginbfchar([\s\S]*?)endbfchar/g, m;
  while ((m = re.exec(txt))) {
    const pr = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let p;
    while ((p = pr.exec(m[1]))) map.set(parseInt(p[1], 16), hexToText(p[2]));
  }
  re = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((m = re.exec(txt))) {
    // <lo> <hi> [<d0> <d1> ...]
    const ar = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([\s\S]*?)\]/g;
    let a;
    while ((a = ar.exec(m[1]))) {
      const lo = parseInt(a[1], 16), hi = parseInt(a[2], 16);
      const list = [...a[3].matchAll(/<([0-9A-Fa-f]+)>/g)].map(x => hexToText(x[1]));
      for (let c = lo, i = 0; c <= hi && i < list.length; c++, i++) map.set(c, list[i]);
    }
    // <lo> <hi> <dst>
    const dr = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let d;
    while ((d = dr.exec(m[1]))) {
      const lo = parseInt(d[1], 16), hi = parseInt(d[2], 16);
      let code = parseInt(d[3], 16);
      for (let c = lo; c <= hi; c++) { map.set(c, String.fromCodePoint(code)); code++; }
    }
  }
  return map;
}

async function inflateZlib(buf) {
  if (buf.length < 2 || (buf[0] & 0x0f) !== 8) return buf.buffer;
  for (const fmt of ["deflate", "deflate-raw"]) {
    try {
      const ds = new DecompressionStream(fmt);
      const ab = await new Response(new Blob([buf]).stream().pipeThrough(ds)).arrayBuffer();
      if (ab.byteLength) return ab;
    } catch (e) { /* next */ }
  }
  return buf.buffer;
}

function bytesToText(bytes, cmap) {
  if (cmap && cmap.size) {
    let out = "";
    // 优先 2 字节 CID 码
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const c = (bytes[i] << 8) | bytes[i + 1];
      const u = cmap.get(c);
      out += u !== undefined ? u : "";
    }
    if (/[\u4e00-\u9fff]/.test(out) || /[A-Za-z0-9]/.test(out)) return out;
    out = "";
    for (const b of bytes) { const u = cmap.get(b); out += u !== undefined ? u : ""; }
    if (out) return out;
  }
  return bytes.map(b => String.fromCharCode(b)).join("");
}

function pdfContentText(ctxt, cmap) {
  if (!cmap || !cmap.size) return "";
  let out = "";
  const btRe = /BT([\s\S]*?)ET/g;
  let m;
  while ((m = btRe.exec(ctxt))) {
    const block = m[1];
    const sRe = /\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]+>(?=\s*(?:Tj|TJ|'|"))/g;
    let s;
    while ((s = sRe.exec(block))) {
      if (s[0].startsWith("<")) {
        const bytes = [];
        const hx = s[0].replace(/[<>\s]/g, "");
        for (let i = 0; i + 1 < hx.length; i += 2) bytes.push(parseInt(hx.slice(i, i + 2), 16));
        out += bytesToText(bytes, cmap);
      } else {
        const bytes = [...pdfUnescape(s[0].slice(1, -1))].map(ch => ch.charCodeAt(0) & 0xff);
        out += bytesToText(bytes, cmap);
      }
    }
    out += "\n";
  }
  return out;
}

async function extractPdfText(buf) {
  const str = bufToLatin1(new Uint8Array(buf));
  if (!str.includes("/Type") || !str.includes("endobj")) return "";
  const objs = parsePdfObjects(str);
  if (!objs.size) return "";
  // 页面：/Type /Page 且含 /Contents
  const pages = [];
  for (const [id, o] of objs) {
    if (/\/Type\s*\/Page[\s\/]/.test(o.dict) && !/\/Type\s*\/Pages[\s\/]/.test(o.dict)) {
      const contents = [];
      let cm = o.dict.match(/\/Contents\s+(\d+)\s+\d+\s+R/);
      if (cm) contents.push(cm[1]);
      cm = o.dict.match(/\/Contents\s*\[([\d\sR]+)\]/);
      if (cm) contents.push(...cm[1].match(/^\d+/g) || cm[1].match(/\d+/g) || []);
      if (contents.length) pages.push({ dict: o.dict, contents });
    }
  }
  if (!pages.length) {
    // 页结构没找到：直接把所有带 /Font 说明的流当内容流（兜底）
    for (const [, o] of objs) {
      if (o.stream && /\/ToUnicode/.test(o.dict)) pages.push({ dict: o.dict, contents: [null], custom: o });
    }
  }
  let outAll = "";
  for (const pg of pages.slice(0, 10)) {
    const cmap = new Map();
    const fontRe = /\/F\d+\s+(\d+)\s+\d+\s+R/g;
    let fm;
    while ((fm = fontRe.exec(pg.dict))) {
      const fobj = objs.get(fm[1]);
      if (!fobj) continue;
      const tou = fobj.dict.match(/\/ToUnicode\s+(\d+)\s+\d+\s+R/);
      if (tou) {
        const cobj = objs.get(tou[1]);
        if (cobj && cobj.stream) {
          try {
            const raw = await inflateZlib(stringToBytes(cobj.stream));
            const parsed = parseCmap(bufToLatin1(raw));
            for (const [k, v] of parsed) cmap.set(k, v);
          } catch (e) { /* ignore font */ }
        }
      }
    }
    if (!cmap.size) continue;
    const streams = pg.custom ? [pg.custom.stream] : [];
    if (!streams.length) {
      for (const cid of pg.contents) {
        const co = objs.get(cid);
        if (co && co.stream) streams.push(co.stream);
      }
    }
    for (const st of streams) {
      try {
        const dec = await inflateZlib(stringToBytes(st));
        outAll += pdfContentText(bufToLatin1(dec), cmap) + "\n";
      } catch (e) { /* skip */ }
    }
    if (outAll.length > 8000) break;
  }
  return outAll.trim().slice(0, 8000);
}

function stringToBytes(s) {
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i) & 0xff;
  return u8;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    if (request.method === "GET") {
      return new Response(HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    if (request.method === "POST" && new URL(request.url).pathname === "/api/analyze") {
      let form;
      try { form = await request.formData(); } catch (e) { return json({ error: "表单解析失败" }, 400); }
      const files = [];
      for (const [k, v] of form.entries()) {
        if (v instanceof File) files.push(v);
      }
      if (!files.length) return json({ error: "没有收到文件" }, 400);
      const MAX_MB = 30;
      const big = files.filter(f => f.size > MAX_MB * 1024 * 1024);
      if (big.length) return json({ error: `以下文件超过 ${MAX_MB}MB 限制：${big.map(f => f.name).join("、")}` }, 413);

      const results = [];
      for (const f of files) {
        const info = await analyzeOne(env, f);
        results.push(info);
      }
      // 英文文件名模式等，不做批内去重（前端处理冲突）
      return json({ ok: true, results });
    }
    if (request.method === "POST" && new URL(request.url).pathname === "/api/health") {
      return json({ ok: true, ai: !!env?.CF_API_TOKEN });
    }
    return json({ error: "not found" }, 404);
  },
};

export { HTML, extractPdfText, analyzeOne };

async function analyzeOne(env, file) {
  const dot = file.name.lastIndexOf(".");
  const ext = dot >= 0 ? file.name.slice(dot + 1).toLowerCase() : "";
  const info = {
    name: file.name, ext, kind: TYPE_NAMES[ext] || (ext || "文件").toUpperCase(),
    size: file.size, text: "", shotTime: "", metaText: "",
  };
  if (!TEXT_EXTS.has(ext) && !OFFICE_EXTS.has(ext) && !IMG_EXTS.has(ext) && ext !== "pdf") {
    info.note = "该类型无法解析内容，按日期+类型命名";
  }
  try {
    const buf = await file.arrayBuffer();
    if (TEXT_EXTS.has(ext)) {
      info.text = await extractTextLike(buf);
    } else if (OFFICE_EXTS.has(ext)) {
      const entries = await parseZip(buf);
      if (entries && entries.length) info.text = await extractOffice(entries, ext);
      else info.note = "Office 文件解析失败（可能是加密或损坏）";
    } else if (IMG_EXTS.has(ext)) {
      const meta = extractImgMeta(buf, ext);
      if (meta.shotTime) info.shotTime = String(meta.shotTime).replace(/:/g, "-");
      if (meta.make || meta.model) info.metaText = `${meta.make || ""} ${meta.model || ""}`.trim();
      info.imgBuf = buf;   // 供视觉模型识别画面内容
      info.text = "";
      info.note = imgNote(info.imgBuf);
    } else if (ext === "pdf") {
      try { info.text = await extractPdfText(buf); } catch (e) { info.text = ""; }
      if (!info.text || info.text.length < 4) {
        info.note = "PDF 未提取到文字（可能是扫描件或加密），按日期+类型命名";
      }
    }
  } catch (e) {
    info.note = "读取失败: " + e.message;
  }

  // AI 优先
  let usedAI = false;
  if (env && env.CF_API_TOKEN) {
    try {
      const theme = await aiSummarize(env, info, info.imgBuf || null);
      info.theme = sanitize(theme, 40);
      usedAI = true;
    } catch (e) {
      info.aiNote = "AI 暂不可用，已用本地分析: " + e.message;
    }
  }
  const local = proposeName(info);
  const date = findDate(info.text, info.name, info);
  const stem = usedAI ? info.theme : local;
  const finalStem = usedAI ? stem : (date ? `${date} ${stem}` : stem);
  // 保证扩展名唯一性
  info.suggested = sanitize(finalStem || "未命名", 50) + "." + (ext || "file");
  info.local = local;
  info.usedAI = usedAI;
  return info;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

// ---------------------------------------------------------------------------
// 前端页面（上传版，沿用时尚 UI）
// 注意：必须用 String.raw 模板 —— 前端 JS 里的正则（\x00-\x1f 等）不能被外层
// 模板字符串提前求值，否则会被转成真实控制字符导致前端脚本语法错误。
// ---------------------------------------------------------------------------

const HTML = String.raw`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>智能改名 · 云端版</title>
<style>
  :root{
    --bg:#0a0e1a; --bg2:#121a2e; --card:rgba(255,255,255,.055); --card-hi:rgba(255,255,255,.1);
    --line:rgba(255,255,255,.09); --txt:#eef1f9; --txt2:#a6aec4; --txt3:#6d7690;
    --accent:#7c5cff; --accent2:#00d4ff; --pink:#ff5d9e; --ok:#2fe6a7; --err:#ff6b6b; --warn:#ffc24b;
    --grad:linear-gradient(120deg,#7c5cff,#4f8bff 45%,#00d4ff);
    --mono:"Cascadia Code",Consolas,Menlo,monospace;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--txt);font-family:"Segoe UI Variable","PingFang SC","Microsoft YaHei UI",system-ui,sans-serif;
    font-size:13.5px;min-height:100vh;overflow-x:hidden}
  ::selection{background:rgba(124,92,255,.45)}
  ::-webkit-scrollbar{width:9px;height:9px}
  ::-webkit-scrollbar-thumb{background:rgba(255,255,255,.14);border-radius:8px}
  .aurora{position:fixed;inset:0;z-index:-2;background:
    radial-gradient(1200px 700px at 82% -10%,rgba(124,92,255,.18),transparent 60%),
    radial-gradient(1000px 600px at -5% 110%,rgba(0,212,255,.12),transparent 55%),
    radial-gradient(800px 500px at 50% 120%,rgba(255,93,158,.09),transparent 60%),
    linear-gradient(180deg,var(--bg),var(--bg2))}
  header{display:flex;align-items:center;gap:14px;padding:16px 22px;border-bottom:1px solid var(--line)}
  .logo{width:34px;height:34px;border-radius:10px;background:var(--grad);display:grid;place-items:center;font-size:16px;color:#fff;box-shadow:0 4px 18px rgba(124,92,255,.5)}
  .brand b{font-size:15px}.brand small{color:var(--txt3);font-size:11px}
  .grow{flex:1}
  .chip{display:inline-flex;align-items:center;gap:6px;padding:5px 11px;border-radius:999px;background:var(--card);
    border:1px solid var(--line);color:var(--txt2);font-size:12px}
  .chip .dot{width:6px;height:6px;border-radius:50%;background:var(--ok);box-shadow:0 0 8px var(--ok)}
  main{max-width:980px;margin:0 auto;padding:26px 20px 90px}
  .drop{position:relative;border:1.6px dashed rgba(255,255,255,.22);border-radius:18px;padding:44px 20px;text-align:center;
    cursor:pointer;transition:.2s;background:rgba(255,255,255,.02)}
  .drop:hover,.drop.drag{border-color:var(--accent);background:rgba(124,92,255,.08)}
  .drop .big{font-size:34px;margin-bottom:8px}
  .drop h2{font-size:16px;font-weight:600}
  .drop p{color:var(--txt3);font-size:12px;margin-top:6px}
  .drop input{display:none}
  .list{margin-top:18px;display:flex;flex-direction:column;gap:10px}
  .fcard{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px;display:flex;gap:12px;align-items:center;transition:.16s}
  .fcard:hover{background:var(--card-hi);transform:translateY(-1px)}
  .fcard .tile{width:38px;height:38px;border-radius:10px;display:grid;place-items:center;font-size:18px;flex:none;
    background:linear-gradient(145deg,rgba(255,255,255,.13),rgba(255,255,255,.03))}
  .fcard .body{flex:1;min-width:0}
  .fcard .names{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .fcard .old{color:var(--txt3);font-size:12.5px;text-decoration:line-through;text-decoration-color:rgba(255,255,255,.35)}
  .arrow{color:var(--accent2);font-size:13px;text-shadow:0 0 10px rgba(0,212,255,.6)}
  .newname{background:transparent;border:1px solid transparent;border-radius:6px;color:#fff;font-size:13.5px;font-weight:600;
    padding:2px 6px;min-width:140px;max-width:100%;font-family:inherit;outline:none}
  .newname:hover{border-color:var(--line)}
  .newname:focus{border-color:var(--accent);background:rgba(124,92,255,.12)}
  .kind{color:var(--txt3);font-size:11.5px;margin-top:3px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .pill{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:999px;font-size:11px;font-weight:600}
  .pill.ai{background:linear-gradient(120deg,rgba(124,92,255,.25),rgba(0,212,255,.22));color:#cfc2ff}
  .pill.local{background:rgba(255,255,255,.07);color:var(--txt2)}
  .pill.warn{background:rgba(255,194,75,.14);color:var(--warn)}
  .fcard .dl{margin-left:auto;flex:none}
  .iconbtn{display:inline-flex;align-items:center;gap:7px;padding:7px 13px;border-radius:10px;background:var(--card);
    border:1px solid var(--line);color:var(--txt);cursor:pointer;font-size:12.5px;transition:.18s;font-family:inherit}
  .iconbtn:hover{background:var(--card-hi)}
  .iconbtn.primary{background:var(--grad);border:none;color:#fff;font-weight:600;box-shadow:0 6px 22px rgba(94,129,255,.45)}
  .iconbtn:disabled{opacity:.45;cursor:default}
  .toolbar{display:flex;align-items:center;gap:8px;margin-top:18px;flex-wrap:wrap}
  .note{color:var(--txt3);font-size:12px}
  #busy{position:fixed;inset:0;z-index:80;display:none;align-items:center;justify-content:center;background:rgba(5,8,16,.45);backdrop-filter:blur(3px)}
  #busy.on{display:flex}
  .spinner{width:44px;height:44px;border-radius:50%;border:3px solid rgba(255,255,255,.12);border-top-color:var(--accent2);animation:spin 1s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  .busy-box{display:flex;flex-direction:column;align-items:center;gap:12px;color:var(--txt2)}
  #toasts{position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:90;display:flex;flex-direction:column;gap:8px;align-items:center}
  .toast{padding:10px 18px;border-radius:12px;font-size:12.8px;background:rgba(24,30,50,.92);border:1px solid rgba(255,255,255,.14);animation:pop .22s ease}
  .toast.ok{border-color:rgba(47,230,167,.45)}
  .toast.err{border-color:rgba(255,107,107,.5);color:#ffc9c9}
  @keyframes pop{from{opacity:0;transform:translateY(-8px)}}
  .ghost{text-align:center;color:var(--txt3);padding:26px;font-size:12.5px;line-height:2}
  @media (max-width:760px){.fcard{flex-wrap:wrap}.fcard .dl{margin-left:0}}
</style>
</head>
<body>
<div class="aurora"></div>
<header>
  <div class="logo">✎</div>
  <div class="brand"><b>智能改名</b><small>CLOUD EDITION · 上传即改名</small></div>
  <div class="grow"></div>
  <span class="chip"><span class="dot"></span>Cloudflare 线上版</span>
</header>

<main>
  <div class="drop" id="drop">
    <div class="big">📂</div>
    <h2>把文件拖进来，或点击选择</h2>
    <p>支持 txt / md / csv / json / docx / xlsx / pptx / 图片等 · 单文件 ≤ 30MB · 一次最多 20 个<br>
    云端只读取内容提炼主题，文件本体不保存，改名后由浏览器本地下载</p>
    <input type="file" id="fileInput" multiple>
  </div>

  <div class="toolbar" id="toolbar" style="display:none">
    <button class="iconbtn primary" id="btnRe">🔄 重新分析全部</button>
    <button class="iconbtn" id="btnClear">清空</button>
    <div class="grow"></div>
    <span class="note">可直接改新名，然后逐个下载</span>
  </div>

  <div class="list" id="list"></div>
  <div class="ghost" id="ghost" style="display:none">分析完成后，这里会列出「旧名 → 新名」，点击下载即得到改名后的文件</div>
</main>

<div id="busy"><div class="busy-box"><div class="spinner"></div><div id="busyText">上传并分析中…</div></div></div>
<div id="toasts"></div>

<script>
"use strict";
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const files = [];  // {file, id, suggested, summary, kind, usedAI, note, status}

function toast(msg, type) {
  const t = document.createElement("div");
  t.className = "toast " + (type || "");
  t.textContent = msg;
  $("toasts").appendChild(t);
  setTimeout(() => { t.style.opacity = "0"; t.style.transition = ".3s"; setTimeout(() => t.remove(), 300); }, 3400);
}
function busy(on, text) {
  $("busy").classList.toggle("on", !!on);
  if (text) $("busyText").textContent = text;
}

const ICONS = { txt:"📄", md:"📝", log:"🗒", csv:"📊", xlsx:"📊", xls:"📊", pptx:"📽", ppt:"📽",
  docx:"📄", doc:"📄", pdf:"📕", jpg:"🖼", jpeg:"🖼", png:"🖼", gif:"🖼", webp:"🖼", mp4:"🎞", zip:"🗜", exe:"⚙️" };
const icon = ext => ICONS[ext] || "📎";

async function analyze(list) {
  if (!list.length) return;
  busy(true, "上传并分析 " + list.length + " 个文件…");
  const fd = new FormData();
  list.forEach(f => fd.append("f", f.file));
  try {
    const r = await fetch("/api/analyze", { method: "POST", body: fd });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || ("HTTP " + r.status));
    data.results.forEach((res, i) => {
      const item = list[i];
      item.suggested = res.suggested || item.file.name;
      item.summary = res.local || res.theme || "";
      item.kind = res.kind;
      item.usedAI = !!res.usedAI;
      item.note = res.note || res.aiNote || "";
      item.status = "ready";
    });
    render();
    const okN = data.results.filter(x => x.suggested).length;
    toast("分析完成：" + okN + " / " + list.length + " 个已给出新名字", "ok");
  } catch (e) {
    toast("分析失败：" + e.message, "err");
    list.forEach(f => { f.status = "fail"; f.note = e.message; });
    render();
  }
  busy(false);
}

function addFiles(fileList) {
  const arr = [...fileList].slice(0, 20);
  arr.forEach(fl => {
    if (files.some(f => f.file.name === fl.name && f.file.size === fl.size)) return;
    files.push({ file: fl, id: files.length + 1, suggested: fl.name, status: "queued" });
  });
  $("toolbar").style.display = "flex";
  $("ghost").style.display = files.length ? "none" : "block";
  render();
  analyze(arr.map(f => files.find(x => x.file === f)));
}

function render() {
  const list = $("list");
  list.innerHTML = "";
  files.forEach(f => {
    const ext = (f.file.name.split(".").pop() || "").toLowerCase();
    const card = document.createElement("div");
    card.className = "fcard";
    const tile = document.createElement("div"); tile.className = "tile"; tile.textContent = icon(ext);
    const body = document.createElement("div"); body.className = "body";
    const names = document.createElement("div"); names.className = "names";
    const old = document.createElement("span"); old.className = "old"; old.textContent = f.file.name; old.title = f.file.name;
    const arr = document.createElement("span"); arr.className = "arrow"; arr.textContent = "→";
    const inp = document.createElement("input"); inp.className = "newname"; inp.value = f.suggested || f.file.name;
    const strName = () => { let v = inp.value.trim().replace(/[\\\/:*?"<>|\x00-\x1f]/g, "_"); inp.value = v; f.suggested = v; };
    inp.addEventListener("change", strName);
    names.append(old, arr, inp);
    const kind = document.createElement("div"); kind.className = "kind";
    kind.innerHTML = "<b>" + esc(f.kind || "未知") + "</b>" + (f.summary ? " · " + esc(f.summary) : "") +
      (f.note ? " · <span style='color:var(--warn)'>"+esc(f.note)+"</span>" : "");
    let pill;
    if (f.status === "queued") { pill = '<span class="pill local">⏳ 分析中…</span>'; }
    else if (f.status === "fail") { pill = '<span class="pill warn">✗ ' + esc(f.note || "失败") + '</span>'; }
    else { pill = f.usedAI ? '<span class="pill ai">✦ AI 总结</span>' : '<span class="pill local">◆ 本地分析</span>'; }
    kind.innerHTML += pill;
    body.appendChild(names); body.appendChild(kind);
    const dl = document.createElement("button");
    dl.className = "iconbtn primary dl";
    dl.textContent = "⬇ 下载";
    dl.disabled = f.status !== "ready";
    dl.onclick = () => downloadOne(f);
    card.append(tile, body, dl);
    list.appendChild(card);
  });
  $("ghost").style.display = files.length ? "none" : "block";
  $("toolbar").style.display = files.length ? "flex" : "none";
}

function downloadOne(f) {
  const name = (f.suggested || f.file.name).trim();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(f.file);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 3000);
  toast("已开始下载：" + name, "ok");
}

$("drop").onclick = () => $("fileInput").click();
$("drop").ondragover = (e) => { e.preventDefault(); $("drop").classList.add("drag"); };
$("drop").ondragleave = () => $("drop").classList.remove("drag");
$("drop").ondrop = (e) => { e.preventDefault(); $("drop").classList.remove("drag"); addFiles(e.dataTransfer.files); };
$("fileInput").onchange = (e) => { addFiles(e.target.files); e.target.value = ""; };
$("btnRe").onclick = () => analyze(files.filter(f => f.status !== "queued"));
$("btnClear").onclick = () => { if (files.length && confirm("清空全部？")) { files.length = 0; render(); } };
render();
</script>
</body>
</html>`;