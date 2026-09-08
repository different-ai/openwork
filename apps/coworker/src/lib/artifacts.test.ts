import assert from "node:assert/strict";
import test from "node:test";
import { artifactsForToolCall } from "./artifacts.ts";

test("CDP handles are never browser links and Coworker pages stay in their discussion", () => {
  for (const key of ["browser_url", "browserUrl", "endpoint", "webSocketDebuggerUrl"]) {
    assert.deepEqual(artifactsForToolCall({ tool: "browser_snapshot", input: { [key]: "http://127.0.0.1:9222", target_id: "app" }, output: {}, metadata: {} }), []);
  }
  assert.deepEqual(artifactsForToolCall({ tool: "coworker_browser_open", input: { url: "https://example.com/" }, output: {}, metadata: {} }), [
    { kind: "browser", label: "example.com", value: "https://example.com/" },
  ]);
});
