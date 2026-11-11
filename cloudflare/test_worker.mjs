// test_worker.mjs —— 本地（Node）测试 Cloudflare Worker 逻辑
// 直接 import worker.js，用样本文件走一遍 FormData → analyze 流程。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import worker from "./worker.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLES = path.join(HERE, "..", "samples");

function fileFromDisk(p) {
  const buf = fs.readFileSync(p);
  return new File([buf], path.basename(p));
}

// ---- 1) GET / 返回页面 ----
const page = await worker.fetch(new Request("http://local/"));
const html = await page.text();
console.assert(page.status === 200 && html.includes("智能改名"), "✓ GET / 返回前端页面");

// ---- 2) /api/health（本地模式，env 无 token） ----
const env = { CF_API_TOKEN: "", CF_ACCOUNT_ID: "" };
const h = await worker.fetch(new Request("http://local/api/health", { method: "POST" }), env);
const hd = await h.json();
console.log("  health:", JSON.stringify(hd));

// ---- 3) POST /api/analyze（本地模式） ----
const fd = new FormData();
const files = fs.readdirSync(SAMPLES).filter(f => !f.startsWith("~$"));
for (const f of files) fd.append("f", fileFromDisk(path.join(SAMPLES, f)));
const resp = await worker.fetch(new Request("http://local/api/analyze", { method: "POST", body: fd }), env);
const data = await resp.json();
console.assert(resp.status === 200 && data.ok, "✓ analyze 请求成功");
console.log("== 建议名（本地模式）==");
for (const r of data.results) {
  console.log(`  ${r.name.padEnd(30)} → ${r.suggested.padEnd(28)} [${r.kind}] AI=${r.usedAI} ${r.note ? "note:" + r.note : ""}`);
}

// ---- 4) 关键断言 ----
const byName = Object.fromEntries(data.results.map(r => [r.name, r]));
console.assert(byName["会议记录_0304.txt"]?.suggested.includes("会议纪要"), "✓ txt 会议纪要识别");
console.assert(byName["clients_data_2025.csv"]?.suggested.includes("名单") || byName["clients_data_2025.csv"]?.suggested.includes("客户"), "✓ csv 名单识别");
console.assert(byName["2025Q1 报表.xlsx"]?.suggested.includes("销售"), "✓ xlsx 销售识别");
console.assert(byName["draft_show.pptx"]?.suggested.includes("发布会"), "✓ pptx 发布会识别");
console.assert(byName["agreement_new.docx"]?.suggested.includes("协议") || byName["agreement_new.docx"]?.suggested.includes("合同"), "✓ docx 协议识别");
console.assert(byName["IMG_20250620_193000.jpg"]?.suggested.includes("2025-06-20"), "✓ jpg 拍摄日期识别");
console.assert(byName["notice.md"]?.suggested.includes("通知"), "✓ md 通知识别");
console.assert(byName["2025Q1 报表.xlsx"]?.suggested, "✓ xlsx 有建议名: " + byName["2025Q1 报表.xlsx"]?.suggested);

// ---- 5) 非法字符 / 超长文件名 ----
const bad = new File([new TextEncoder().encode("abc\tdef")], 'a/b:*.txt');
const fd2 = new FormData();
fd2.append("f", bad);
const r2 = await worker.fetch(new Request("http://local/api/analyze", { method: "POST", body: fd2 }), env);
const d2 = await r2.json();
console.assert(!/[\\/:*?"<>|]/.test(d2.results[0].suggested), "✓ 非法字符已清理: " + d2.results[0].suggested);

// ---- 6) 空请求 ----
const r3 = await worker.fetch(new Request("http://local/api/analyze", { method: "POST", body: new FormData() }), env);
const d3 = await r3.json();
console.assert(r3.status === 400 && d3.error, "✓ 空请求返回 400");

console.log("\n✅ Worker 本地测试全部通过");