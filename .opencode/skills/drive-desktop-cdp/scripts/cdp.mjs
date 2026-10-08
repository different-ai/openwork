#!/usr/bin/env node
// Drive a running OpenWork desktop window over CDP: evaluate, screenshot, open
// a new session, send a prompt with a chosen model, refresh providers.
//
//   CDP_URL=http://127.0.0.1:55322 node cdp.mjs eval '<js expression>'
//   node cdp.mjs shot out.png
//   node cdp.mjs new-session
//   node cdp.mjs send "<model name as shown in the picker>" "<prompt>"
//   node cdp.mjs wait-idle [timeoutSeconds]
//   node cdp.mjs refresh-providers
//
// CDP_URL defaults to the `pnpm dev` port (9823). A world prints its own CDP
// URL when it starts (`pnpm world up live-desktop` → "cdp http://…").
import { writeFileSync } from "node:fs";

const CDP_URL = (process.env.CDP_URL ?? "http://127.0.0.1:9823").replace(/\/$/, "");

async function connect() {
  const targets = await (await fetch(`${CDP_URL}/json/list`)).json();
  const target = targets.find((t) => t.type === "page" && t.title === "OpenWork") ?? targets.find((t) => t.type === "page");
  if (!target) throw new Error(`No OpenWork page at ${CDP_URL}`);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let id = 0;
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  };
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const send = (method, params = {}) => new Promise((resolve) => {
    const next = ++id;
    pending.set(next, resolve);
    ws.send(JSON.stringify({ id: next, method, params }));
  });
  return { ws, send };
}

async function evaluate(expression) {
  const { ws, send } = await connect();
  try {
    const reply = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    const result = reply.result;
    if (result?.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "Evaluation failed");
    return result?.result?.value;
  } finally {
    ws.close();
  }
}

async function screenshot(path) {
  const { ws, send } = await connect();
  try {
    const reply = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(path, Buffer.from(reply.result.data, "base64"));
  } finally {
    ws.close();
  }
}

// The current workspace id comes from the route, so nothing is hardcoded.
const WORKSPACE = `(location.hash.match(/#\\/workspace\\/([^/]+)/) || [])[1]`;

const newSession = () => evaluate(`(async () => {
  const workspace = ${WORKSPACE};
  if (!workspace) throw new Error("Open a workspace first");
  location.hash = "#/workspace/" + workspace + "/session";
  await new Promise((r) => setTimeout(r, 1500));
  return location.href;
})()`);

const sendPrompt = (model, prompt) => evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const wait = async (find) => { for (let i = 0; i < 30; i++) { const el = find(); if (el) return el; await sleep(100); } return null; };
  if (!document.querySelector('input[aria-label^="Search"]')) document.querySelector('button[aria-label="Change model"]')?.click();
  const search = await wait(() => document.querySelector('input[aria-label^="Search"]'));
  if (!search) throw new Error("Model picker did not open");
  search.focus(); search.select?.();
  document.execCommand("insertText", false, ${JSON.stringify(model)});
  await sleep(400);
  const option = [...document.querySelectorAll('[role="option"], button, [cmdk-item]')]
    .find((el) => el.innerText.split("\\n")[0].trim() === ${JSON.stringify(model)});
  if (!option) throw new Error("Model not found in the picker: " + ${JSON.stringify(model)});
  option.click();
  await sleep(300);
  const editor = document.querySelector('[contenteditable="true"][data-lexical-editor="true"]');
  editor.focus();
  const data = new DataTransfer();
  data.setData("text/plain", ${JSON.stringify(prompt)});
  editor.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
  await sleep(250);
  document.querySelector('button[aria-label="Run task"]').click();
  return "sent";
})()`);

async function waitIdle(timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  await new Promise((r) => setTimeout(r, 3000));
  while (Date.now() < deadline) {
    if (await evaluate(`!!document.querySelector('button[aria-label="Run task"]')`)) return "idle";
    await new Promise((r) => setTimeout(r, 2000));
  }
  return "timeout";
}

// Saving a provider key through the app's own endpoint makes the OpenWork
// server mirror providers into the v2 engine. The token never leaves the page.
const refreshProviders = () => evaluate(`(async () => {
  const workspace = ${WORKSPACE};
  const port = localStorage.getItem("openwork.server.port");
  const token = localStorage.getItem("openwork.server.token");
  if (!workspace || !port || !token) throw new Error("Need an open local workspace");
  const response = await fetch("http://127.0.0.1:" + port + "/workspace/" + workspace + "/opencode/auth/fault-lab", {
    method: "PUT",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "api", key: "fault" }),
  });
  return response.status;
})()`);

const [command, ...args] = process.argv.slice(2);
const run = {
  eval: () => evaluate(args[0]),
  shot: () => screenshot(args[0] ?? "shot.png").then(() => args[0] ?? "shot.png"),
  "new-session": newSession,
  send: () => sendPrompt(args[0], args[1]),
  "wait-idle": () => waitIdle(Number(args[0] ?? 180)),
  "refresh-providers": refreshProviders,
}[command];
if (!run) {
  console.error("usage: cdp.mjs eval|shot|new-session|send|wait-idle|refresh-providers …");
  process.exit(1);
}
const value = await run();
console.log(typeof value === "string" ? value : JSON.stringify(value, null, 1));
