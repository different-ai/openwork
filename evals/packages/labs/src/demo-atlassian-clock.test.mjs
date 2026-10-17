import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

test("Atlassian narrative clock resets identical business state and audits actual MCP calls", async (t) => {
  const socket = createServer(); socket.listen(0, "127.0.0.1"); await once(socket, "listening");
  const port = socket.address().port; await new Promise((resolve) => socket.close(resolve));
  const child = spawn(process.execPath, [new URL("./demo-atlassian.mjs", import.meta.url).pathname], { env: { PATH: process.env.PATH, HOST: "127.0.0.1", PORT: String(port), DEMO_NOW: "2026-10-16T15:55:00Z" }, stdio: "ignore" });
  t.after(async () => { if (child.exitCode !== null || child.signalCode !== null) return; const exited = once(child, "exit"); child.kill(); await exited; });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && !await fetch(`${base}/health`).then((r) => r.ok).catch(() => false)) await delay(50);
  const before = await fetch(`${base}/state`).then((r) => r.json());
  assert.deepEqual(before.audit, []);
  const now = Date.now();
  const result = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "jira_get_issue", arguments: { issue_key: "FLEET-342" } } }) }).then((r) => r.json());
  assert.equal(result.result.isError, false);
  const after = await fetch(`${base}/state`).then((r) => r.json());
  assert.equal(after.audit.length, 1);
  assert.equal(after.audit[0].name, "jira_get_issue");
  assert.equal(after.audit[0].status, "completed");
  assert.equal(after.audit[0].output, result.result.content[0].text);
  assert.ok(after.audit[0].at >= now && after.audit[0].at <= Date.now());
  await fetch(`${base}/reset`, { method: "POST" });
  assert.deepEqual(await fetch(`${base}/state`).then((r) => r.json()), before);
});
