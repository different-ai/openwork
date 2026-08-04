import assert from "node:assert/strict";
import test from "node:test";
import { parseSessionToolCalls } from "../src/desktop.ts";

test("parses namespaced and catalog tool calls from a session transcript", () => {
  // Mirrors session.read_transcript's messages shape and messageToReadableText's
  // dynamic-tool rendering in apps/app/src/.../session-surface.tsx:1853-1878,355-376.
  const calls = parseSessionToolCalls({
    sessionId: "ses_1",
    messageCount: 1,
    returned: 1,
    messages: [{
      index: 0,
      role: "assistant",
      text: [
        "OpenWork",
        "[tool:mcp:emc_labs:send_email] sent",
        "[tool:native:emc_robotics:postCapabilitiesGoogleWorkspaceGmailDrafts] drafted",
        "[tool:openwork-cloud_execute_capability] searched",
      ].join("\n\n"),
    }],
  });

  assert.deepEqual(calls, [
    { capability: "mcp:emc_labs:send_email", connectionId: "emc_labs", at: "" },
    {
      capability: "native:emc_robotics:postCapabilitiesGoogleWorkspaceGmailDrafts",
      connectionId: "emc_robotics",
      at: "",
    },
    { capability: "openwork-cloud_execute_capability", connectionId: null, at: "" },
  ]);
});

test("returns no tool calls for an empty transcript", () => {
  assert.deepEqual(parseSessionToolCalls({ sessionId: "ses_1", messageCount: 0, returned: 0, messages: [] }), []);
});
