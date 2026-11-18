import assert from "node:assert/strict";
import { test } from "node:test";
import { agentPermissionDefinition } from "@openwork/types/den/agent-permissions";
import { agentPermissionBlockedBy, agentPermissionChoiceOptions, agentPermissionChoiceValue, hostExecutionRowVisible, storedAgentPermissionDecision, visibleAgentPermissionGroups } from "./agent-permissions-presentation";

const keys = (hostExecution: boolean) => visibleAgentPermissionGroups("all", { hostExecution }).flatMap((group) => group.definitions.map((definition) => definition.key));

test("Where the agent runs commands sits with commands, and only when the editor offers it", () => {
  assert.deepEqual(keys(true).slice(0, 2), ["commands", "hostExecution"]);
  assert.equal(keys(false).includes("hostExecution"), false);
  assert.equal(visibleAgentPermissionGroups("browser").flatMap((group) => group.definitions).some((definition) => definition.key === "hostExecution"), false);
});

test("execution location names environments and preserves explicit computer versus member choice", () => {
  const definition = agentPermissionDefinition("hostExecution");
  assert.equal(definition.label, "Where the agent runs commands");
  assert.deepEqual(agentPermissionChoiceOptions(definition, null), [
    { value: "inherit", label: "Member chooses" },
    { value: "allow", label: "On this computer" },
    { value: "deny", label: "In a sandbox (isolated)" },
  ]);
  assert.equal(agentPermissionChoiceValue(definition, undefined, "allow"), "inherit");
  assert.equal(agentPermissionChoiceValue(definition, "allow", "allow"), "allow");
  assert.equal(agentPermissionChoiceValue(definition, "deny", "deny"), "deny");
  assert.equal(storedAgentPermissionDecision(definition, null, "allow"), "allow");
  assert.equal(storedAgentPermissionDecision(definition, null, undefined), undefined);
});

test("teams show Everyone's actual location and reset through Use Everyone's, not an inherit choice", () => {
  const definition = agentPermissionDefinition("hostExecution");
  assert.deepEqual(agentPermissionChoiceOptions(definition, "Research", "deny"), [
    { value: "allow", label: "On this computer" },
    { value: "deny", label: "In a sandbox (isolated)" },
  ]);
  assert.equal(agentPermissionChoiceValue(definition, undefined, "deny", "deny"), "deny");
  assert.equal(agentPermissionChoiceValue(definition, "allow", "allow", "deny"), "allow");
  assert.equal(agentPermissionChoiceValue(definition, undefined, "allow", undefined), "inherit");
  assert.equal(agentPermissionChoiceOptions(definition, "Research")[0]?.label, "Member chooses");
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
