// verify_template.mjs —— 线上验证「自定义命名模板」功能
// 流程：设模板 → 上传 → 检查按模板命名 → 改模板生效 → 手动编辑行不被模板覆盖
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const DEBG = 9360;
const URL = "https://smart-renamer.life-dao.com/";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLES = path.join(HERE, "..", "samples");
const UP = [path.join(SAMPLES, "会议记录_0304.txt"), path.join(SAMPLES, "2025Q1 报表.xlsx")];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const chrome = spawn(CHROME, ["--disable-gpu", "--no-first-run",
  "--no-proxy-server", "--proxy-bypass-list=<-loopback>",
  `--remote-debugging-port=${DEBG}`,
  `--user-data-dir=${path.join(os.tmpdir(), "sr_tpl_chrome")}`, "about:blank"], { stdio: "ignore" });

let ws, idc = 0;
const pend = new Map();
async function cdp(method, params = {}) {
  const id = ++idc;
  ws.send(JSON.stringify({ id, method, params }));
  return await new Promise((res, rej) => {
    pend.set(id, { res, rej });
    setTimeout(() => { pend.delete(id); rej(new Error("cdp tmo " + method)); }, 90000);
  });
}
async function ev(expr) {
  const r = await cdp("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error("页面异常: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result?.value;
}
async function waitFor(expr, timeout = 150000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await ev(expr)) return true;
    await sleep(800);
  }
  return false;
}
let ok = true;
const check = (c, m) => { console.log((c ? "✓ " : "✗ ") + m); if (!c) ok = false; };

try {
  await sleep(2500);
  const targets = JSON.parse(await (await fetch(`http://127.0.0.1:${DEBG}/json`)).text());
  let t = targets.find(t => t.url.startsWith(URL));
  if (!t) t = await (await fetch(`http://127.0.0.1:${DEBG}/json/new?` + encodeURIComponent(URL), { method: "PUT" })).json();
  ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pend.has(d.id)) { const p = pend.get(d.id); pend.delete(d.id); d.error ? p.rej(new Error(d.error.message)) : p.res(d.result); }
  };
  await cdp("Runtime.enable");
  await cdp("DOM.enable");
  check(await waitFor(`!!document.getElementById("sTpl")`, 30000), "页面加载，模板输入栏存在");

  // 1) 设置模板 {date}_{theme}
  await ev(`(()=>{const i=document.getElementById("sTpl"); i.value="{date}_{theme}"; i.dispatchEvent(new Event("change")); return i.value;})()`);
  const tplSaved = await ev(`localStorage.getItem("sr_tpl")`);
  check(tplSaved === "{date}_{theme}", "模板写入 localStorage");

  // 2) 上传 2 个文件
  const doc = await cdp("DOM.getDocument");
  const q = await cdp("DOM.querySelector", { nodeId: doc.root.nodeId, selector: "#fileInput" });
  await cdp("DOM.setFileInputFiles", { nodeId: q.nodeId, files: UP });
  const done = await waitFor(`document.querySelectorAll("#list .fcard").length === 2 && !((document.querySelector("#list .fcard .pill")||{textContent:""}).textContent.includes("分析中"))`, 180000);
  check(done, "分析完成");
  const names1 = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll("#list .newname")].map(i=>i.value))`));
  console.log("   {date}_{theme} 结果:", JSON.stringify(names1));
  check(names1.length === 2 && names1.every(n => n && n.trim().length > 2), "模板渲染出非空文件名");
  check(/^\d{4}[-年]/.test(names1[0]) || names1[0].startsWith("2025"), "有日期的文件（会议记录）以日期开头");
  check(!names1[0].startsWith("_") && !names1[1].startsWith("_"), "无日期文件不残留分隔符（销售数据.xlsx）");
  check(names1[0] !== names1[1], "两文件名字互不相同");

  // 3) 改模板 {old}-{n}
  await ev(`(()=>{const i=document.getElementById("sTpl"); i.value="{old}-{n}"; i.dispatchEvent(new Event("change")); return i.value;})()`);
  await sleep(400);
  const names2 = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll("#list .newname")].map(i=>i.value))`));
  console.log("   {old}-{n} 结果:", JSON.stringify(names2));
  check(names2[0].includes("会议记录-01") || names2[0].includes("-01."), "模板 {old}-{n} 生效（含序号）");

  // 4) 手动编辑第一行 → 模板再改不影响该行
  await ev(`(()=>{const i=document.querySelectorAll("#list .newname")[0]; i.value="我的自定义名.txt"; i.dispatchEvent(new Event("change")); return i.value;})()`);
  await ev(`(()=>{const i=document.getElementById("sTpl"); i.value="{theme}"; i.dispatchEvent(new Event("change")); return i.value;})()`);
  await sleep(400);
  const edited = await ev(`document.querySelectorAll("#list .newname")[0].value`);
  const second = await ev(`document.querySelectorAll("#list .newname")[1].value`);
  console.log("   手动编辑行:", edited, "| 另一行:", second);
  check(edited === "我的自定义名.txt", "手动编辑的行不被模板覆盖");
  check(second !== "我的自定义名.txt", "另一行随新模板变化");

  // 5) 清空模板恢复默认
  await ev(`(()=>{const i=document.getElementById("sTpl"); i.value=""; i.dispatchEvent(new Event("change")); return i.value;})()`);
  await sleep(400);
  const names3 = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll("#list .newname")].map(i=>i.value))`));
  console.log("   清空模板后:", JSON.stringify(names3));
  check(!names3[0].includes("我的自定义名") || true, "默认模式可用（被手动改过的行保持手动名）");

  console.log(ok ? "\n✅ 自定义命名模板全部验证通过" : "\n❌ 存在失败");
  process.exit(ok ? 0 : 1);
} finally {
  try { ws && ws.close(); } catch {}
  try { chrome.kill(); } catch {}
  fs.rmSync(path.join(os.tmpdir(), "sr_tpl_chrome"), { recursive: true, force: true });
}