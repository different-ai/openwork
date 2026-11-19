import assert from "node:assert/strict";
import { test } from "node:test";
import nativeContext from "../src/opencode-plugins/openwork-context-v2.js";

test("stopped native Code Mode commands do not dispatch and propagate the cancellation", async () => {
  type Editor = Parameters<Parameters<Parameters<typeof nativeContext.setup>[0]["tool"]["transform"]>[0]>[0];
  const tools: Array<Parameters<Editor["add"]>[0]> = [];
  const stop = await nativeContext.setup({
    options: { url: "http://127.0.0.1:1/read", token: "read-only" },
    tool: { async transform(callback) { callback({ add: tool => tools.push(tool) }); return { async dispose() {} }; } },
    skill: { async transform() { return { async dispose() {} }; }, async reload() {} },
  });
  try {
    const execute = tools.find(tool => tool.name === "openwork_execute");
    assert.ok(execute);
    const aborted = new Error("Stopped by the person");
    await assert.rejects(execute.execute({ id: "session.group.move", args: { sessionId: "ses_target", groupId: "done" } }, {
      signal: AbortSignal.abort(aborted), sessionID: "ses_caller", agent: "build", messageID: "msg_test", id: "call_test",
    }), error => error === aborted);
  } finally { await stop(); }
});
