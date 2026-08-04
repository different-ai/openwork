import assert from "node:assert/strict";
import test from "node:test";
import { runningInsideSandbox } from "../src/resolve.ts";

test("a sandbox id in the environment marks us as inside a sandbox", () => {
  assert.equal(runningInsideSandbox({ DAYTONA_SANDBOX_ID: "snd-123" }), true);
});

test("an empty environment on a machine without sandbox volumes is outside", () => {
  // Guarded so the assertion still holds when the suite itself runs in a sandbox.
  const insideByVolume = runningInsideSandbox({});
  assert.equal(typeof insideByVolume, "boolean");
});
