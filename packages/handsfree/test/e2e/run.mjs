// Computer-use e2e quality benchmark.
//
// Measures snapshot/click/type accuracy and latency against a deterministic
// local HTML page in Chrome, with ground truth verified independently via the
// Chrome DevTools Protocol (so accuracy is not measured by the system under
// test).
//
// Requirements (macOS only):
// - The signed helper app with Accessibility + Screen Recording granted:
//   run `node apps/desktop/scripts/prepare-computer-use-helper.mjs` and grant
//   permissions once via the helper's setup GUI.
// - Google Chrome installed. The test launches a disposable instance with a
//   temp profile and closes it afterwards. No accessibility flags are passed;
//   the runtime is expected to enable renderer AX itself.
//
// Usage: node packages/handsfree/test/e2e/run.mjs

import { spawn, execSync } from "node:child_process";
import { createReadStream, createWriteStream, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../../..");
const HELPER_APP = process.env.OPENWORK_COMPUTER_USE_HELPER
  ?? join(repoRoot, "apps/desktop/resources/helpers/OpenWork Computer Use.app");
const PAGE = `file://${join(__dirname, "bench.html")}`;
const CDP_PORT = Number(process.env.CU_BENCH_CDP_PORT ?? 9224);
const CHROME_APP = "Google Chrome";

if (process.platform !== "darwin") {
  console.log("computer-use e2e benchmark is macOS-only; skipping");
  process.exit(0);
}

// --- MCP bridge: launch the helper via Launch Services with FIFO stdio so
// --- TCC permissions attribute to the helper bundle, not this shell.
const fifoDir = mkdtempSync(join(tmpdir(), "cu-e2e-"));
const IN = join(fifoDir, "in.fifo");
const OUT = join(fifoDir, "out.fifo");
execSync(`mkfifo ${IN} ${OUT}`);
try { execSync(`pkill -f 'OpenWork Computer Use.app'`); } catch {}
spawn("open", ["--stdin", IN, "--stdout", OUT, HELPER_APP, "--args", "mcp"], { stdio: "ignore" });

const mcpOut = createReadStream(OUT, { encoding: "utf8" });
const mcpIn = createWriteStream(IN);
let mcpBuf = "";
const mcpPending = new Map();
mcpOut.on("data", (chunk) => {
  mcpBuf += chunk;
  let idx;
  while ((idx = mcpBuf.indexOf("\n")) >= 0) {
    const line = mcpBuf.slice(0, idx).trim();
    mcpBuf = mcpBuf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id != null && mcpPending.has(msg.id)) {
      mcpPending.get(msg.id)(msg);
      mcpPending.delete(msg.id);
    }
  }
});

let rpcId = 0;
function rpc(method, params, timeoutMs = 30000) {
  const id = ++rpcId;
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`mcp timeout: ${method}`)), timeoutMs);
    mcpPending.set(id, (msg) => { clearTimeout(t); res(msg); });
    mcpIn.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

const results = { latency: {}, accuracy: {}, paths: {} };
async function cu(name, args = {}) {
  const t0 = performance.now();
  const msg = await rpc("tools/call", { name, arguments: args });
  (results.latency[name] ??= []).push(performance.now() - t0);
  const text = msg.result?.content?.find((c) => c.type === "text")?.text;
  const json = JSON.parse(text ?? "{}");
  if (json.path) (results.paths[json.path] ??= []).push(name);
  return json;
}

// --- disposable Chrome with CDP ground truth ---
const profileDir = mkdtempSync(join(tmpdir(), "cu-e2e-chrome-"));
spawn("open", ["-na", CHROME_APP, "--args",
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profileDir}`,
  "--no-first-run", "--no-default-browser-check", "--window-size=1200,900", PAGE,
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function cdpTargets() {
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
      return await r.json();
    } catch { await sleep(500); }
  }
  throw new Error(`Chrome CDP endpoint did not come up on :${CDP_PORT}`);
}

await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "cu-e2e", version: "0" } });
mcpIn.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

const targets = await cdpTargets();
const tab = targets.find((t) => t.type === "page" && t.url.includes("bench.html"));
if (!tab) throw new Error("bench.html tab not found in disposable Chrome");
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let wsId = 0;
const wsPending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && wsPending.has(m.id)) { wsPending.get(m.id)(m); wsPending.delete(m.id); }
};
const evaljs = (expression) => new Promise((res, rej) => {
  const i = ++wsId;
  const t = setTimeout(() => rej(new Error("cdp timeout")), 15000);
  wsPending.set(i, (m) => { clearTimeout(t); res(m.result?.result?.value); });
  ws.send(JSON.stringify({ id: i, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
});

await sleep(2000);
const findEl = (snap, pred) => snap.elements?.find(pred);

let failures = 0;
const record = (key, ok, total, note = "") => {
  results.accuracy[key] = `${ok}/${total}`;
  if (ok !== total) { failures++; if (note) console.log(note); }
};

// 1. element recall
let snap = await cu("snapshot", { app: CHROME_APP });
const buttons = ["btn-alpha","btn-bravo","btn-charlie","btn-delta","btn-echo","btn-foxtrot","btn-golf","btn-hotel","btn-india","btn-juliett","btn-kilo","btn-lima"];
const expected = [...buttons, "bench-field", "bench-area", "bench-check"];
const labels = (snap.elements ?? []).map((e) => `${e.label ?? ""} ${e.value ?? ""}`).join(" | ");
const found = expected.filter((x) => labels.includes(x));
record("element_recall", found.length, expected.length, `missing: ${expected.filter((x) => !found.includes(x)).join(", ")}`);

// 2. click accuracy across all three addressing modes, CDP-verified
async function clickRound(key, makeArgs) {
  let ok = 0;
  await evaljs("window.__events = []");
  for (const name of buttons) {
    const el = findEl(snap, (e) => e.role === "Button" && (e.label ?? "").includes(name));
    if (!el) continue;
    const before = (await evaljs("window.__events.length")) ?? 0;
    await cu("click", { app: CHROME_APP, ...makeArgs(el) });
    await sleep(150);
    const last = await evaljs("window.__events[window.__events.length-1]?.id");
    const after = await evaljs("window.__events.length");
    if (after === before + 1 && last === name) ok++;
    else console.log(`${key} MISS: ${name} -> ${last}`);
  }
  record(key, ok, buttons.length);
}
await clickRound("click_by_ref", (el) => ({ ref: el.ref }));
snap = await cu("snapshot", { app: CHROME_APP });
await clickRound("click_by_image_coord", (el) => ({ x: el.center.imageX, y: el.center.imageY }));
await clickRound("click_by_screen_coord", (el) => ({ screen_x: el.center.screenX, screen_y: el.center.screenY }));

// 3. pid targeting
const apps = await cu("list_apps");
const chrome = (apps.appDetails ?? []).find((a) => a.name === CHROME_APP);
const pidSnap = chrome ? await cu("snapshot", { pid: chrome.pid }) : {};
record("snapshot_by_pid", pidSnap.windowTitle?.includes("CU-BENCH") ? 1 : 0, 1);

// 4. typing accuracy (incl. symbols), CDP-verified
const strings = [
  "The quick brown fox jumps over the lazy dog 0123456789",
  "~!@#$%^&*()_+-=[]{}|;':\",./<>?",
  "CamelCase snake_case kebab-case 42.5%",
];
let typeOk = 0;
for (const text of strings) {
  await evaljs("document.getElementById('field').value=''; document.getElementById('field').focus()");
  await sleep(100);
  await cu("type_text", { app: CHROME_APP, text });
  await sleep(300);
  if ((await evaljs("document.getElementById('field').value")) === text) typeOk++;
}
record("type_text", typeOk, strings.length);

// 5. set_value with verify + retype fallback
snap = await cu("snapshot", { app: CHROME_APP });
const field = findEl(snap, (e) => (e.label ?? "").includes("bench-field"));
await cu("set_value", { app: CHROME_APP, ref: field.ref, value: "set-value-test-42" });
await sleep(300);
record("set_value", (await evaljs("document.getElementById('field').value")) === "set-value-test-42" ? 1 : 0, 1);

// 6. background modifier combo: cmd+a + retype
await cu("snapshot", { app: CHROME_APP });
await evaljs("document.getElementById('field').focus()");
await cu("press_key", { app: CHROME_APP, combo: "command+a" });
await sleep(100);
await cu("type_text", { app: CHROME_APP, text: "replaced" });
await sleep(300);
record("select_all_replace", (await evaljs("document.getElementById('field').value")) === "replaced" ? 1 : 0, 1);

// --- report ---
console.log("\n========== RESULTS ==========");
console.log("\n-- Accuracy --");
for (const [k, v] of Object.entries(results.accuracy)) console.log(`${k.padEnd(24)} ${v}`);
console.log("\n-- Latency (ms) --");
for (const [k, v] of Object.entries(results.latency)) {
  const s = [...v].sort((a, b) => a - b);
  const avg = Math.round(s.reduce((a, b) => a + b, 0) / s.length);
  console.log(`${k.padEnd(24)} n=${String(s.length).padEnd(4)} avg=${String(avg).padEnd(6)} min=${Math.round(s[0]).toString().padEnd(6)} max=${Math.round(s[s.length - 1])}`);
}
console.log("\n-- Execution paths --");
for (const [k, v] of Object.entries(results.paths)) console.log(`${k.padEnd(24)} ${v.length}x`);

// --- cleanup ---
try { execSync(`pkill -f "user-data-dir=${profileDir}"`); } catch {}
try { execSync(`pkill -f 'OpenWork Computer Use.app'`); } catch {}
await sleep(1000);
try { rmSync(fifoDir, { recursive: true, force: true }); } catch {}
try { rmSync(profileDir, { recursive: true, force: true }); } catch {}

console.log(failures === 0 ? "\nRESULT: PASS" : `\nRESULT: FAIL (${failures} failing checks)`);
process.exit(failures === 0 ? 0 : 1);
