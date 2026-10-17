// Fixture contract tests only; these are NOT model/scheduler execution evidence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

test("synthetic news, isolated due jobs and operator receipts never execute inference or delivery", { timeout: 15000 }, async (t) => {
  const listener = createServer(); listener.listen(0, "127.0.0.1"); await once(listener, "listening");
  const port = listener.address().port; await new Promise((resolve) => listener.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [new URL("./demo-workshop-news.mjs", import.meta.url).pathname], { env: { PATH: process.env.PATH, HOST: "127.0.0.1", PORT: String(port), DEMO_NOW: "2026-10-16T15:55:00Z", WORKSHOP_OPERATOR_TOKEN: "fixture-contract-test-only" }, stdio: "ignore" });
  t.after(async () => { const exited = once(child, "exit"); child.kill(); await exited; });
  let healthy = false;
  for (let i = 0; i < 100; i++) { if (await fetch(base + "/health").then((r) => r.ok).catch(() => false)) { healthy = true; break; } await delay(50); }
  assert.equal(healthy, true);
  const readState = async () => (await fetch(base + "/state")).json();
  const initial = await readState();
  assert.equal(initial.now, "2026-10-16T15:55:00.000Z");
  let id = 0;
  const rpc = async (method, params = {}) => (await fetch(base + "/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) })).json();
  const tool = async (name, args = {}) => { const response = await rpc("tools/call", { name, arguments: args }); assert.equal(response.result.isError, false, JSON.stringify(response)); return JSON.parse(response.result.content[0].text); };
  assert.equal((await rpc("initialize", { protocolVersion: "2025-06-18" })).result.protocolVersion, "2025-06-18");
  const tools = (await rpc("tools/list")).result.tools;
  assert.deepEqual(tools.map((tool) => tool.name), ["news_list", "news_search", "news_read", "news_schedule_create", "news_schedule_list"]);
  assert.equal(tools.filter((tool) => tool.name !== "news_schedule_create").every((tool) => tool.annotations.readOnlyHint), true);
  assert.equal(tools.find((tool) => tool.name === "news_schedule_create").annotations.readOnlyHint, false);
  const started = Date.now();
  const all = await tool("news_list"); assert.equal(all.value.length, 8);
  for (const country of ["France", "United States", "Germany", "Japan"]) {
    const matches = await tool("news_search", { country }); assert.equal(matches.value.length, 2);
    for (const article of matches.value) {
      assert.ok(article.title && article.summary && article.outlet && article.country);
      assert.equal(new URL(article.url).hostname, "workshop-news.example");
      assert.equal((await tool("news_read", { article: article.url })).body.includes(article.summary), true);
      assert.equal((await tool("news_read", { article: article.id })).id, article.id);
    }
  }
  assert.equal((await tool("news_search", { query: "no such story" })).value.length, 0);
  const unknown = await rpc("tools/call", { name: "news_read", arguments: { article: "https://real-news.invalid" } }); assert.equal(unknown.result.isError, true);
  const advance = async (now) => fetch(base + "/clock", { method: "POST", body: JSON.stringify({ now }) });
  await advance("2026-10-16T16:00:00Z"); // 09:00 America/Los_Angeles, setup state only.
  const state = await readState();
  assert.equal(state.clockEvents.length, 1); assert.equal(state.isolatedDueJobs, true); assert.equal(state.productionScheduler, false); assert.equal(state.inferenceRunner, false); assert.deepEqual(state.events, []);
  assert.equal(state.inferenceExecuted, false); assert.equal(state.deliveryExecuted, false);
  assert.equal(state.clockEvents[0].inferenceExecuted, false); assert.equal(state.clockEvents[0].deliveryExecuted, false);
  assert.equal((await advance("2026-10-15T16:00:00Z")).status, 400);
  assert.equal((await fetch(base + "/clock", { method: "POST", headers: { origin: "https://hostile.invalid" }, body: JSON.stringify({ now: "2026-10-17T16:00:00Z" }) })).status, 403);
  const audit = (await readState()).audit;
  assert.equal(audit.length, 23); // Discovery, HTTP clock/state and reset are not tool calls.
  assert.deepEqual(audit[0], { sequence: 1, at: audit[0].at, name: "news_list", input: {}, output: all, status: "completed" });
  assert.equal(audit.at(-1).status, "error"); assert.equal(audit.at(-1).output, unknown.result.content[0].text);
  for (const entry of audit) { assert.ok(entry.at >= started && entry.at <= Date.now()); assert.equal("callId" in entry, false); }
  for (let i = 0; i < 1001; i++) await tool("news_read", { article: "fr-grid" });
  const retained = (await readState()).audit;
  assert.equal(retained.length, 1000); assert.equal(retained[0].sequence, 25); assert.equal(retained.at(-1).sequence, 1024);
  await fetch(base + "/reset", { method: "POST" }); assert.deepEqual(await readState(), initial);
  const forbidden = await rpc("tools/call", { name: "fixture_schedule_create", arguments: {} }); assert.equal(forbidden.result.isError, true);
  const final = await readState();
  assert.equal(final.audit.length, 1); assert.equal(final.audit[0].sequence, 1); assert.equal(final.audit[0].status, "error");
  assert.deepEqual({ ...final, audit: [] }, initial);

  // Scheduling/receipt contract tests with synthetic IDs, NOT paid-execution evidence.
  await fetch(base + "/reset", { method: "POST" });
  const args = { name: "Morning synthetic news", hour: 9, minute: 0, time_zone: "America/Los_Angeles", instructions: "At the due time read the selected sources and save a digest and an unsent draft through actual connected tools." };
  const job = await tool("news_schedule_create", args);
  assert.equal(job.id, "job-1"); assert.equal(job.nextDueAt, "2026-10-16T16:00:00.000Z");
  assert.equal(job.instructions, args.instructions); assert.equal(job.inferenceExecuted, false); assert.equal(job.deliveryExecuted, false);
  const registrationAudit = (await readState()).audit[0];
  assert.equal(registrationAudit.name, "news_schedule_create"); assert.deepEqual(registrationAudit.input, args); assert.deepEqual(registrationAudit.output, job);
  const invalid = async (arguments_) => { const response = await rpc("tools/call", { name: "news_schedule_create", arguments: arguments_ }); assert.equal(response.result.isError, true); };
  await invalid({ ...args, time_zone: "UTC" }); await invalid({ ...args, hour: 24 }); await invalid({ ...args, minute: -1 });
  await invalid({ ...args, inferenceExecuted: true }); await invalid({ ...args, instructions: " " });
  assert.equal((await readState()).jobs.length, 1);
  await advance("2026-10-16T15:59:59Z"); assert.deepEqual((await readState()).events, []);
  const due = await (await advance("2026-10-16T16:00:00Z")).json();
  assert.equal(due.dueEvents.length, 1); assert.equal(due.events.length, 1);
  const event = due.dueEvents[0];
  assert.equal(event.id, "event-1"); assert.equal(event.jobId, job.id); assert.equal(event.dueAt, "2026-10-16T16:00:00.000Z");
  assert.equal(event.status, "due"); assert.equal(event.executionReceipt, null); assert.equal(event.inferenceExecuted, false); assert.equal(event.deliveryExecuted, false);
  const scheduled = await tool("news_schedule_list"); assert.equal(scheduled.jobs[0].nextDueAt, "2026-10-17T16:00:00.000Z");
  await advance("2026-10-16T16:00:00Z"); assert.equal((await readState()).events.length, 1);
  const auditBeforeReceipt = (await readState()).audit;
  const receiptInput = { eventId: event.id, sessionId: "contract-test-session-not-real-inference", digestFileId: "contract-test-file", draftId: "contract-test-draft", inferenceWitnessSequence: 1 };
  const receipt = (input, token) => fetch(base + "/execution-receipt", { method: "POST", headers: token ? { "x-workshop-operator-token": token } : {}, body: JSON.stringify(input) });
  assert.equal((await receipt(receiptInput)).status, 403); assert.equal((await receipt(receiptInput, "wrong-token")).status, 403);
  const operator = "fixture-contract-test-only";
  assert.equal((await receipt({ ...receiptInput, eventId: "unknown" }, operator)).status, 400);
  assert.equal((await receipt({ ...receiptInput, sessionId: "" }, operator)).status, 400);
  assert.equal((await receipt({ ...receiptInput, inferenceWitnessSequence: 0 }, operator)).status, 400);
  assert.equal((await receipt({ ...receiptInput, inferenceExecuted: true }, operator)).status, 400);
  assert.equal((await readState()).inferenceExecuted, false);
  const acknowledged = await (await receipt(receiptInput, operator)).json();
  assert.equal(acknowledged.event.executionReceipt.sessionId, receiptInput.sessionId);
  assert.equal(acknowledged.receipt.operatorAttested, true); assert.equal(acknowledged.receipt.independentlyVerifiedByFixture, false);
  assert.equal(acknowledged.inferenceRunner, false);
  const afterReceipt = await readState();
  assert.equal(afterReceipt.events[0].status, "operator_receipt_recorded"); assert.equal(afterReceipt.jobs[0].executionReceipts.length, 1);
  assert.equal(afterReceipt.inferenceExecuted, true); assert.equal(afterReceipt.deliveryExecuted, true); assert.equal(afterReceipt.inferenceRunner, false);
  assert.deepEqual(afterReceipt.audit, auditBeforeReceipt); // No fake MCP call or logged operator token.
  assert.equal(JSON.stringify(afterReceipt).includes(operator), false);
  assert.equal((await receipt(receiptInput, operator)).status, 400);
  assert.equal((await rpc("tools/call", { name: "news_execution_receipt", arguments: receiptInput })).result.isError, true);
  await advance("2026-10-17T16:00:00Z");
  const daily = await readState(); assert.equal(daily.events.length, 2); assert.equal(daily.events[1].inferenceExecuted, false); assert.equal(daily.events[1].executionReceipt, null);
  assert.deepEqual(registrationAudit.output.executionReceipts, []); // Audit snapshot did not gain the later receipt.

  await fetch(base + "/reset", { method: "POST" });
  await advance("2026-10-31T15:55:00Z"); await tool("news_schedule_create", args);
  const dst = await (await advance("2026-11-01T17:00:00Z")).json();
  assert.deepEqual(dst.dueEvents.map((event) => event.dueAt), ["2026-10-31T16:00:00.000Z", "2026-11-01T17:00:00.000Z"]);
  assert.equal(dst.jobs[0].nextDueAt, "2026-11-02T17:00:00.000Z");
  await fetch(base + "/reset", { method: "POST" }); assert.deepEqual(await readState(), initial);
});
