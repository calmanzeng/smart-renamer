// verify_online2.mjs —— 干净路径的线上验证（文件方式运行，import.meta.url 正确）
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const DEBG = 9348;
const URL = "https://smart-renamer.calman198705.workers.dev/";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLES = path.join(HERE, "..", "samples");
const UP = [path.join(SAMPLES, "会议记录_0304.txt"), path.join(SAMPLES, "2025Q1 报表.xlsx")];
console.log("样本路径:", UP.join(" | "));
console.log("存在性:", UP.map(p => fs.existsSync(p)).join(" | "));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const chrome = spawn(CHROME, ["--disable-gpu", "--no-first-run",
  "--proxy-server=http://127.0.0.1:7078", `--remote-debugging-port=${DEBG}`,
  `--user-data-dir=${path.join(os.tmpdir(), "sr_cf_v2")}`, "about:blank"], { stdio: "ignore" });

let ws, idc = 0;
const pend = new Map();
async function cdp(method, params = {}) {
  const id = ++idc;
  ws.send(JSON.stringify({ id, method, params }));
  return await new Promise((res, rej) => {
    pend.set(id, { res, rej });
    setTimeout(() => { pend.delete(id); rej(new Error("tmo " + method)); }, 90000);
  });
}
async function ev(expr) {
  const r = await cdp("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
}
async function waitFor(expr, timeout = 120000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await ev(expr)) return true;
    await sleep(800);
  }
  return false;
}
const step = (m) => console.log("[step]", m);
const guard = async (label, fn) => {
  try { const v = await fn(); console.log("[ok]", label, v === undefined ? "" : JSON.stringify(v)); return v; }
  catch (e) { console.log("[!!]", label, "失败:", e.message); return null; }
};

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
  await sleep(1500);
  step("连接页面成功");

  const doc = await guard("DOM.getDocument", () => cdp("DOM.getDocument"));
  const q = await guard("query #fileInput", () => cdp("DOM.querySelector", { nodeId: doc.root.nodeId, selector: "#fileInput" }));
  await guard("setFileInputFiles", () => cdp("DOM.setFileInputFiles", { nodeId: q.nodeId, files: UP }));
  await sleep(3000);
  step("上传注入完成");

  // 先确认 File 本身可读（正确路径下）
  const readOk = await guard("磁盘 File 读取", () => ev(`(async()=>{
    const f = files[0];
    if (!f) return "no-files";
    try { const ab = await f.file.arrayBuffer(); return "read-ok size=" + f.file.size + " ab=" + ab.byteLength; }
    catch (e) { return "read-fail: " + e.message; }
  })()`));
  console.log("磁盘 File 读取:", readOk);

  const t0 = Date.now();
  const done = await guard("等待分析完成", () => waitFor(`(()=>{
    const p = (document.querySelector("#list .fcard .pill")||{}).textContent || "";
    return document.querySelectorAll("#list .fcard").length === 2 && !p.includes("分析中");
  })()`, 180000));
  console.log("等待结果:", done, "用了", ((Date.now() - t0) / 1000).toFixed(1), "s");
  const st = await guard("采集页面状态", () => ev(`JSON.stringify({
    pill: (document.querySelector("#list .fcard .pill")||{}).textContent || "",
    names: [...document.querySelectorAll("#list .newname")].map(i=>i.value),
    dl: [...document.querySelectorAll("#list .fcard .dl")].map(b=>b.disabled),
    toasts: [...document.querySelectorAll(".toast")].map(t=>t.textContent),
  })`));
  console.log("状态:", st);

  const stObj = st ? JSON.parse(st) : {};
  const ok = !!done && stObj.names?.every(n => n && !n.includes("分析中"));
  console.log(ok ? "\n✅ 线上端到端验证通过" : "\n❌ 验证未通过");
  process.exit(ok ? 0 : 1);
} finally {
  try { ws && ws.close(); } catch {}
  try { chrome.kill(); } catch {}
  fs.rmSync(path.join(os.tmpdir(), "sr_cf_v2"), { recursive: true, force: true });
}