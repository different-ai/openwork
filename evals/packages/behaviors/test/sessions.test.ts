import assert from "node:assert/strict";
import test from "node:test";

import { renameSessionAndWait } from "../src/sessions.ts";
import type { SessionControl } from "../src/sessions.ts";

test("renameSessionAndWait polls until the renamed title is observable", async () => {
  let renameCalls = 0;
  let listCalls = 0;
  const control: SessionControl = async (action) => {
    if (action === "session.rename") {
      renameCalls += 1;
      return null;
    }
    assert.equal(action, "session.list_sessions");
    listCalls += 1;
    return [{ sessionId: "session-1", title: listCalls === 1 ? "New session" : "Expected title" }];
  };

  await renameSessionAndWait(control, "session-1", "Expected title", { timeoutMs: 100, intervalMs: 0 });

  assert.equal(renameCalls, 1);
  assert.equal(listCalls, 2);
});

test("renameSessionAndWait retries the rename once when its title never lands", async () => {
  let renameCalls = 0;
  const control: SessionControl = async (action) => {
    if (action === "session.rename") {
      renameCalls += 1;
      return null;
    }
    assert.equal(action, "session.list_sessions");
    return [{ sessionId: "session-1", title: renameCalls === 1 ? "New session" : "Expected title" }];
  };

  await renameSessionAndWait(control, "session-1", "Expected title", { timeoutMs: 0, intervalMs: 0 });

  assert.equal(renameCalls, 2);
});
