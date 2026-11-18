import assert from "node:assert/strict";
import { test } from "node:test";
import { agentPermissionBlockedBy, hostExecutionRowVisible, visibleAgentPermissionGroups } from "./agent-permissions-presentation";

const keys = (hostExecution: boolean) => visibleAgentPermissionGroups("all", { hostExecution }).flatMap((group) => group.definitions.map((definition) => definition.key));

test("Run tools on this computer sits with commands, and only when the editor offers it", () => {
  assert.deepEqual(keys(true).slice(0, 2), ["commands", "hostExecution"]);
  assert.equal(keys(false).includes("hostExecution"), false);
  assert.equal(visibleAgentPermissionGroups("browser").flatMap((group) => group.definitions).some((definition) => definition.key === "hostExecution"), false);
});

test("with the rollout off the row shows only where a setting is already saved", () => {
  const off = { sandboxOnly: false };
  assert.equal(hostExecutionRowVisible({ sandboxOnly: true }, {}, null), true);
  assert.equal(hostExecutionRowVisible(off, {}, null), false);
  assert.equal(hostExecutionRowVisible(off, { hostExecution: { decision: "deny" } }, null), true);
  assert.equal(hostExecutionRowVisible(off, {}, { hostExecution: { decision: "deny" } }), true);
  assert.equal(hostExecutionRowVisible(off, {}, {}), false);
});

test("a required sandbox locks what the host refuses, and says so when the sandbox is off", () => {
  const required = { hostExecution: { decision: "deny" as const } };
  for (const key of ["computerUse", "computerFiles", "computerClipboard", "appScripting", "localMcpServers"]) {
    assert.equal(agentPermissionBlockedBy(key, required, null)?.key, "host-execution", key);
    assert.equal(agentPermissionBlockedBy(key, {}, required)?.key, "host-execution", `${key} inherits Everyone's`);
    assert.equal(agentPermissionBlockedBy(key, { hostExecution: { decision: "allow" } }, required), null, `${key} follows the team's own setting`);
  }
  assert.equal(agentPermissionBlockedBy("commands", required, null), null);
  assert.equal(agentPermissionBlockedBy("hostExecution", required, null, { sandboxOnly: true }), null);
  assert.equal(agentPermissionBlockedBy("hostExecution", required, null, { sandboxOnly: false })?.key, "sandbox-off");
  assert.equal(agentPermissionBlockedBy("hostExecution", {}, null, { sandboxOnly: false }), null);
});
