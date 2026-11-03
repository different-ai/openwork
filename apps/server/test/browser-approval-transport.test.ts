import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, type TestContext } from "node:test";
import { Agent, getGlobalDispatcher, setGlobalDispatcher, fetch as undiciFetch } from "undici";
import nativeContext from "../src/opencode-plugins/openwork-context-v2.js";
import { createV2BrowserBridge } from "../src/opencode-v2-browser-bridge.js";
import { uiBridgeRequest } from "../src/opencode-plugins/openwork-ui-bridge.js";
import { approvalLoopbackFetch } from "../src/opencode-plugins/approval-loopback-fetch.js";

// Node's fetch normally waits 300 s for headers. Undici exposes its coarse
// timer clock for tests: advance that clock, not wall time or the permission
// owner's timer. Use Node (not Bun), since this is the shipped Node transport.
const require = createRequire(import.meta.url);
const timers: { tick(delay?: number): void; reset(): void } = require("undici/lib/util/timers.js");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 25));

test("control: the default dispatcher cuts off an unanswered approval at five minutes", { timeout: 10_000 }, async (t) => {
  const received = deferred<void>();
  const server = createServer((_request, _response) => { received.resolve(); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const agent = new Agent();
  t.after(async () => { await agent.destroy(); server.closeAllConnections(); server.close(); timers.reset(); });
  const result = undiciFetch(`http://127.0.0.1:${address.port}/approval`, { dispatcher: agent }).catch((error: unknown) => error);
  await received.promise;
  timers.tick(); // Activate newly registered coarse timers before advancing them.
  timers.tick(301_000);
  const error = await result;
  assert.ok(error instanceof Error && error.cause && typeof error.cause === "object" && "code" in error.cause);
  assert.equal(error.cause.code, "UND_ERR_HEADERS_TIMEOUT");
});

async function approvalRoundTrip(t: TestContext, answer: "allow" | "deny" | "cancel") {
  const root = await mkdtemp(join(tmpdir(), "browser-approval-"));
  const previousDiscovery = process.env.OPENWORK_UI_CONTROL_DISCOVERY;
  const previousDispatcher = getGlobalDispatcher();
  // Also makes native fetch use this test's accelerated timer clock on the
  // unfixed tree. The production fix uses its own narrowly scoped dispatcher.
  const defaultAgent = new Agent();
  setGlobalDispatcher(defaultAgent);
  const received = deferred<void>();
  const approval = deferred<boolean>();
  const cancelled = deferred<void>();
  let deliveries = 0;
  const desktop = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    if (request.url === "/skills") { response.end(JSON.stringify({ skills: [] })); return; }
    assert.equal(request.url, "/browser/task");
    assert.equal(request.headers.authorization, "Bearer fixture-desktop-token");
    const body: unknown = JSON.parse(text);
    assert.ok(body && typeof body === "object" && "sessionId" in body && body.sessionId === "ses_fixture");
    response.once("close", () => { if (!response.writableEnded) { cancelled.resolve(); approval.resolve(false); } });
    received.resolve();
    const allowed = await approval.promise;
    if (response.destroyed) return;
    if (allowed) deliveries++;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ ok: allowed, outcome: allowed ? "attached" : "files_declined" }));
  });
  await new Promise<void>((resolve) => desktop.listen(0, "127.0.0.1", resolve));
  const address = desktop.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const discovery = join(root, "bridge.json");
  await writeFile(discovery, JSON.stringify({ baseUrl, token: "fixture-desktop-token" }));
  process.env.OPENWORK_UI_CONTROL_DISCOVERY = discovery;
  const bridge = await createV2BrowserBridge();
  let attach: { execute(input: unknown, call: { signal: AbortSignal; sessionID: string }): Promise<unknown> } | undefined;
  const stop = await nativeContext.setup({
    options: { url: `${baseUrl}/skills`, token: "fixture-skills-token", browser: bridge },
    tool: { async transform(callback) {
      callback({ add(tool) { if (tool.name === "browser_act") attach = tool; } });
      return { async dispose() {} };
    } },
    skill: { async transform() { return { async dispose() {} }; }, async reload() {} },
  });
  t.after(async () => {
    approval.resolve(false);
    await stop();
    await bridge.close();
    desktop.closeAllConnections();
    await new Promise<void>((resolve) => desktop.close(() => resolve()));
    setGlobalDispatcher(previousDispatcher);
    await defaultAgent.destroy();
    timers.reset();
    if (previousDiscovery === undefined) delete process.env.OPENWORK_UI_CONTROL_DISCOVERY;
    else process.env.OPENWORK_UI_CONTROL_DISCOVERY = previousDiscovery;
    await rm(root, { recursive: true, force: true });
  });
  assert.ok(attach);
  const controller = new AbortController();
  let settled = false;
  const result = attach.execute({ observationId: "observation_fixture", action: {
    type: "attach", ref: "e1", files: ["/fixture/clip.mp4"],
  } }, { sessionID: "ses_fixture", signal: controller.signal }).finally(() => { settled = true; });
  // Observe rejections immediately so a regression doesn't become an unhandled rejection.
  result.catch(() => undefined);
  await received.promise;
  timers.tick(); // Activate newly registered coarse timers before advancing them.
  timers.tick(301_000);
  await pause();
  assert.equal(settled, false, "the original tool call is still waiting for the person's answer, not browser_disconnected");
  assert.equal(deliveries, 0, "waiting never hands over the file");
  if (answer === "cancel") {
    controller.abort();
    await assert.rejects(result);
    await Promise.race([cancelled.promise, new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("desktop request was not cancelled")), 2000);
      timer.unref();
    })]);
    assert.equal(deliveries, 0, "cancellation reaches the desktop through both hops");
    return;
  }
  approval.resolve(answer === "allow");
  const reply = await result;
  assert.deepEqual(reply, { content: [{ type: "text", text: JSON.stringify({ ok: answer === "allow", outcome: answer === "allow" ? "attached" : "files_declined" }) }] });
  assert.equal(deliveries, answer === "allow" ? 1 : 0, "the original request completes once, only with approval");
}

for (const answer of ["allow", "deny", "cancel"] as const) {
  test(`v2 attach keeps both HTTP hops alive past five minutes, then handles ${answer}`, { timeout: 10_000 }, (t) => approvalRoundTrip(t, answer));
}

test("cancelling an approval-capable desktop call closes the request before it can attach", { timeout: 10_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "browser-cancel-"));
  const previous = process.env.OPENWORK_UI_CONTROL_DISCOVERY;
  const received = deferred<void>();
  const cancelled = deferred<void>();
  const desktop = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume the request body */ }
    response.once("close", () => { if (!response.writableEnded) cancelled.resolve(); });
    received.resolve();
  });
  await new Promise<void>((resolve) => desktop.listen(0, "127.0.0.1", resolve));
  const address = desktop.address();
  assert.ok(address && typeof address !== "string");
  const discovery = join(root, "bridge.json");
  await writeFile(discovery, JSON.stringify({ baseUrl: `http://127.0.0.1:${address.port}`, token: "fixture-token" }));
  process.env.OPENWORK_UI_CONTROL_DISCOVERY = discovery;
  t.after(async () => {
    desktop.closeAllConnections(); desktop.close();
    if (previous === undefined) delete process.env.OPENWORK_UI_CONTROL_DISCOVERY;
    else process.env.OPENWORK_UI_CONTROL_DISCOVERY = previous;
    await rm(root, { recursive: true, force: true });
  });
  const controller = new AbortController();
  const reply = uiBridgeRequest("/browser/task", { method: "POST", body: { operation: "act" }, signal: controller.signal, timeoutMs: null });
  await received.promise;
  controller.abort();
  const result = await reply;
  assert.ok(result && typeof result === "object" && "ok" in result && result.ok === false);
  await Promise.race([cancelled.promise, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("desktop request was not cancelled")), 2000))]);
});

test("the approval transport rejects external destinations and redirects", async (t) => {
  const signal = new AbortController().signal;
  await assert.rejects(approvalLoopbackFetch("https://example.com/", { signal }), /local HTTP endpoint/);
  const server = createServer((_request, response) => { response.writeHead(302, { Location: "https://example.com/" }); response.end(); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await assert.rejects(approvalLoopbackFetch(`http://127.0.0.1:${address.port}/`, { signal }), /fetch failed/);
});
