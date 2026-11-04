import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createV2ContextBridge } from "../src/opencode-v2-context-bridge.js";
import { fakeEngine } from "./fixtures/drive-approval-engine.js";

test("Stop still cancels an approved Drive transfer after removing the total timeout", { timeout: 5_000 }, async () => {
  const engine = await fakeEngine({ effect: "ask", reply: "once" });
  const started = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  const bridge = await createV2ContextBridge(async (_path, init) => {
    assert.ok(init?.signal);
    started.resolve();
    try { await delay(10_000, undefined, { signal: init.signal }); }
    catch (error) { cancelled.resolve(); throw error; }
    assert.fail("a stopped transfer must not complete");
  }, () => engine.connection);
  const stop = new AbortController();
  try {
    const request = fetch(bridge.url, { method: "POST", headers: { Authorization: `Bearer ${bridge.token}`, "Content-Type": "application/json" }, signal: stop.signal,
      body: JSON.stringify({ name: "openwork_drive_upload", input: { path: "archive.zip" }, sessionId: "ses_one", caller: { directory: "/workspace", messageId: "msg_one", callId: "call_one" } }),
    });
    void request.catch(() => undefined);
    await started.promise;
    stop.abort();
    await assert.rejects(request);
    await Promise.race([cancelled.promise, delay(2_000, undefined, { ref: false }).then(() => { throw new Error("Stop did not reach the transfer"); })]);
    assert.equal(engine.prompts.length, 1);
  } finally { stop.abort(); await bridge.close(); await engine.close(); }
});
