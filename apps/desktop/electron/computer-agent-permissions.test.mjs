import assert from "node:assert/strict";
import { test } from "node:test";
import { createComputerAgentPermissions } from "./computer-agent-permissions.mjs";

test("a sandbox-only host denial is picked up on the next computer boundary without a cache window", async () => {
  let required = false;
  let reads = 0;
  const permissions = createComputerAgentPermissions({
    readRules: async () => { reads++; return required ? [{ action: "computer", resource: "*", effect: "deny", source: "Sandbox-only mode" }] : []; },
    confirm: async () => { throw new Error("A required sandbox cannot be approved into host execution"); },
  });
  assert.deepEqual(await permissions.check({ kind: "computer", sessionId: "root" }), { effect: "allow" });
  required = true;
  for (const sessionId of ["root", "child"]) {
    const decision = await permissions.check({ kind: "computer", sessionId });
    assert.equal(decision.effect, "deny");
    assert.match(decision.message, /Sandbox-only mode/);
  }
  assert.equal(reads, 3);
});

test("ordinary offline behaviour is retained, and a failed read cannot lift a verified sandbox denial", async () => {
  let unavailable = false;
  let rules = [];
  const permissions = createComputerAgentPermissions({ readRules: async () => { if (unavailable) throw new Error("offline"); return rules; }, confirm: async () => false });
  assert.equal((await permissions.check({ kind: "computer" })).effect, "allow");
  unavailable = true;
  assert.equal((await permissions.check({ kind: "computer" })).effect, "allow");
  unavailable = false;
  rules = [{ action: "computer", resource: "*", effect: "deny", source: "Sandbox-only mode" }];
  assert.equal((await permissions.check({ kind: "computer" })).effect, "deny");
  unavailable = true;
  assert.equal((await permissions.check({ kind: "computer" })).effect, "deny");
});
