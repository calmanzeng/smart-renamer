// browser_e2e.mjs —— 用无头 Chrome（CDP）对 Web 界面做真实交互测试
// 跑前需要：webui.py 已在 8756 端口运行，samples/ 存在。
// 用法：node browser_e2e.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = "http://127.0.0.1:8756/";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const DEBG = 9333;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLES = path.join(HERE, "samples");
const WORK = path.join(HERE, "_browser_e2e");

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const assert = (cond, msg) => { if (!cond) { console.error("✗ " + msg); process.exit(1); } console.log("✓ " + msg); };

// ---------- 1. 准备测试副本 ----------
fs.rmSync(WORK, { recursive: true, force: true });
fs.cpSync(SAMPLES, WORK, { recursive: true });
const workFiles = () => fs.readdirSync(WORK).sort();

// ---------- 2. 启动 Chrome ----------
const chrome = spawn(CHROME, [
  "--headless=new",
  "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  `--remote-debugging-port=${DEBG}`,
  `--user-data-dir=${path.join(os.tmpdir(), "sr_e2e_chrome")}`,
  "about:blank",
], { stdio: "ignore" });

let ws;
let msgId = 0;
const pending = new Map();
async function cdp(method, params = {}) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return await new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => { pending.delete(id); reject(new Error("CDP 超时: " + method)); }, 60000);
  });
}
async function evalJS(expr, awaitPromise = false) {
  const r = await cdp("Runtime.evaluate", {
    expression: expr, awaitPromise, returnByValue: true,
  });
  if (r.exceptionDetails) throw new Error("页面异常: " + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails));
  return r.result?.value;
}
async function waitFor(expr, timeoutMs = 30000, what = expr) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      if (await evalJS(expr)) return true;
    } catch (e) { /* 页面还没就绪 */ }
    await sleep(300);
  }
  throw new Error("等待超时: " + what);
}

try {
  try {
    // 等调试端口
    await waitFor(`(async()=>{ try{ await fetch("http://127.0.0.1:${DEBG}/json/version"); return true; }catch(e){ return false; } })()`,
      20000, "Chrome 调试端口");
  } catch { /* 端口没等到也继续，后面连接时会再报错 */ }
  await sleep(500);

// ---------- 3. 连上页面 ----------
const targets = JSON.parse(await (await fetch(`http://127.0.0.1:${DEBG}/json`)).text());
let target = targets.find(t => t.url.startsWith(APP));
if (!target) {
  const t = await (await fetch(`http://127.0.0.1:${DEBG}/json/new?` + encodeURIComponent(APP), { method: "PUT" })).json();
  target = t;
}
assert(!!target, "页面 Target 创建");
ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
};
await cdp("Runtime.enable");
await cdp("Page.enable");
assert(await waitFor(`document.readyState === "complete"`, 20000, "页面加载"), "页面加载完成");

// ---------- 4. 空状态 ----------
assert(await waitFor(`!!document.querySelector(".empty-state")`, 10000), "空状态渲染");

// ---------- 5. 进入样本目录 ----------
const dirEsc = JSON.stringify(WORK);
await evalJS(`loadBrowse(${dirEsc})`);
await waitFor(`document.querySelectorAll("#browse .file-item").length === ${workFiles().length}`, 15000, "目录加载");
assert(true, `目录列出 ${workFiles().length} 个文件`);
const firstNames = await evalJS(`[...document.querySelectorAll("#browse .file-item .nm")].map(x=>x.textContent).join(",")`);
assert(firstNames.split(",").length === workFiles().length, "文件名渲染");

// ---------- 6. 勾选全部并添加 ----------
await evalJS(`document.querySelectorAll("#browse .file-item input[type=checkbox]").forEach(c=>c.click())`);
const checkedN = await evalJS(`[...document.querySelectorAll("#browse .file-item.checked")].length`);
assert(checkedN === workFiles().length, `勾选 ${checkedN} 个文件（点击后高亮）`);
const selLabel = await evalJS(`document.getElementById("selCount").textContent`);
assert(selLabel.includes(String(workFiles().length)), "添加按钮计数显示");
await evalJS(`document.getElementById("btnAddSel").click()`);
await waitFor(`document.querySelectorAll("#workList .fcard").length === ${workFiles().length}`, 40000, "分析完成出现卡片");
assert(true, "7 个文件全部出现在改名台");

// ---------- 7. 建议名非空 / 有状态胶囊 ----------
const newNames = await evalJS(`[...document.querySelectorAll("#workList .newname")].map(i=>i.value)`);
assert(newNames.length === 7 && newNames.every(n => n && n.length > 3), "每个文件都有建议新名字");
const pillN = await evalJS(`document.querySelectorAll("#workList .fcard .pill").length`);
assert(pillN === 7, "状态胶囊渲染");
const statText = await evalJS(`document.getElementById("statChip").textContent`);
assert(statText.includes("7"), "顶部统计显示 7 个文件");

// ---------- 8. 重点摘要抽屉 ----------
await evalJS(`document.querySelectorAll("#workList .fcard")[0].click()`);
assert(await waitFor(`document.getElementById("drawer").classList.contains("open")`, 8000), "点卡片打开重点摘要抽屉");

// ---------- 9. 一键改名 ----------
await evalJS(`document.getElementById("btnRename").click()`);
await waitFor(`document.querySelectorAll("#workList .pill.done").length === 7`, 40000, "改名完成");
assert(true, "全部 7 个标记为「已改名」");
await sleep(600);
const onDisk = workFiles();
const renamed = onDisk.some(n => n.includes("会议纪要")) && onDisk.some(n => n.includes("销售"));
assert(renamed, "磁盘上文件名已实际改变: " + onDisk.join(", "));

// ---------- 10. 撤销 ----------
await evalJS(`document.getElementById("btnUndo").click()`);
await waitFor(`document.querySelectorAll("#workList .fcard").length >= 7 && !document.querySelector("#workList .pill.done")`, 40000, "撤销后重新分析");
await sleep(800);
const restored = workFiles();
assert(JSON.stringify(restored) === JSON.stringify(fs.readdirSync(SAMPLES).sort()), "撤销后文件名全部还原: " + restored.join(", "));

// ---------- 11. 设置弹窗 ----------
await evalJS(`document.getElementById("btnSettings").click()`);
assert(await waitFor(`document.getElementById("settingsMask").classList.contains("open")`, 8000), "设置弹窗打开");
const keyShown = await evalJS(`document.getElementById("sKey").value !== undefined`);
assert(keyShown, "设置项加载");
await evalJS(`document.getElementById("sCancel").click()`);
assert(await waitFor(`!document.getElementById("settingsMask").classList.contains("open")`, 5000), "取消关闭弹窗");

console.log("\n✅ 浏览器端到端全部通过（无头 Chrome 真实交互）");
} finally {
  try { ws && ws.close(); } catch {}
  try { chrome.kill(); } catch {}
  // 等 Chrome 完全退出后再清临时目录（清理失败不报错）
  fs.rmSync(WORK, { recursive: true, force: true });
  try {
    let tries = 5;
    while (tries-- > 0) {
      try { fs.rmSync(path.join(os.tmpdir(), "sr_e2e_chrome"), { recursive: true, force: true }); break; }
      catch { await new Promise(r => setTimeout(r, 500)); }
    }
  } catch {}
}