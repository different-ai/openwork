import assert from "node:assert/strict";
import { test } from "node:test";
import { agentPermissionDefinition, type AgentPermissionSettings } from "@openwork/types/den/agent-permissions";
import { agentPermissionBlockedBy, agentPermissionToggleState, sandboxRequirementVisibility, storedAgentPermissionDecision, visibleAgentPermissionGroups } from "./agent-permissions-presentation";

const on = { sandboxTools: true };
const off = { sandboxTools: false };
const force: AgentPermissionSettings = { hostExecution: { decision: "deny" } };
const use: AgentPermissionSettings = { sandboxOptOut: { decision: "deny" } };

test("both requirements sit in Commands and files, not Browser", () => {
  const [commands] = visibleAgentPermissionGroups("all", sandboxRequirementVisibility(on, {}, null));
  assert.equal(commands?.label, "Commands and files");
  assert.deepEqual(commands.definitions.slice(0, 3).map((definition) => definition.key), ["commands", "sandboxOptOut", "hostExecution"]);
  assert.equal(visibleAgentPermissionGroups("browser").flatMap((group) => group.definitions).some((definition) => definition.key === "hostExecution" || definition.key === "sandboxOptOut"), false);
});

test("stored and inherited requirements remain visible while rollout is off", () => {
  assert.deepEqual(sandboxRequirementVisibility(off, {}, null), { hostExecution: false, sandboxOptOut: false });
  for (const [settings, everyone] of [[use, {}], [{}, use]]) {
    assert.deepEqual(sandboxRequirementVisibility(off, settings, everyone), { hostExecution: false, sandboxOptOut: true });
  }
  for (const [settings, everyone] of [[force, {}], [{}, force]]) {
    assert.deepEqual(sandboxRequirementVisibility(off, settings, everyone), { hostExecution: true, sandboxOptOut: true });
  }
  const [commands] = visibleAgentPermissionGroups("all", sandboxRequirementVisibility(off, {}, null));
  assert.equal(commands?.definitions.some((definition) => definition.key === "hostExecution" || definition.key === "sandboxOptOut"), false);
});

test("a requirement that was turned back off leaves the editor once the rollout is off", () => {
  const released: AgentPermissionSettings = { sandboxOptOut: { decision: "allow" }, hostExecution: { decision: "allow" } };
  assert.deepEqual(sandboxRequirementVisibility(off, released, null), { hostExecution: false, sandboxOptOut: false });
  assert.deepEqual(sandboxRequirementVisibility(off, released, {}), { hostExecution: false, sandboxOptOut: false });
  // A team's own exception stays visible while Everyone still requires the mode.
  assert.deepEqual(sandboxRequirementVisibility(off, released, { ...use, ...force }), { hostExecution: true, sandboxOptOut: true });
  assert.deepEqual(sandboxRequirementVisibility(on, released, null), { hostExecution: true, sandboxOptOut: true });
});

test("Force shows Use checked and locked without changing its stored decision", () => {
  const definition = agentPermissionDefinition("sandboxOptOut");
  const included = agentPermissionBlockedBy("sandboxOptOut", {}, force, on);
  assert.deepEqual(included, { key: "force-includes-use", reason: "Included in Force OpenWork Sandbox" });
  for (const decision of ["allow", "deny"] satisfies ("allow" | "deny")[]) {
    assert.deepEqual(agentPermissionToggleState(definition, decision, included?.key), { checked: true, disabled: true, onDecision: "deny", offDecision: "allow" });
    assert.deepEqual(agentPermissionToggleState(definition, decision), { checked: decision === "deny", disabled: false, onDecision: "deny", offDecision: "allow" });
  }
});

test("Force annotates dependent controls, and Use alone does not", () => {
  for (const key of ["computerUse", "computerFiles", "computerClipboard", "appScripting", "localMcpServers"]) {
    assert.equal(agentPermissionBlockedBy(key, force, null)?.reason, "Blocked while Force OpenWork Sandbox is on.");
    assert.equal(agentPermissionBlockedBy(key, {}, force)?.reason, "Blocked while Force OpenWork Sandbox is on.");
    assert.equal(agentPermissionBlockedBy(key, { hostExecution: { decision: "allow" } }, force), null, `${key} follows the team's own setting`);
    assert.equal(agentPermissionBlockedBy(key, use, null), null);
  }
  assert.equal(agentPermissionBlockedBy("fileEdits", force, null), null);
  assert.equal(agentPermissionBlockedBy("hostExecution", force, null, on), null);
});

test("rollout off shows the existing requirement and lets an admin switch it off, not on", () => {
  const keys = ["hostExecution", "sandboxOptOut"] satisfies (keyof AgentPermissionSettings)[];
  for (const key of keys) {
    const lock = agentPermissionBlockedBy(key, {}, null, off);
    assert.equal(lock?.key, "sandbox-off");
    const definition = agentPermissionDefinition(key);
    assert.equal(agentPermissionToggleState(definition, "allow", lock?.key).disabled, true);
    assert.equal(agentPermissionToggleState(definition, "deny", lock?.key).disabled, false);
  }
});

test("private-value permissions sit with the browser's, only while their rollout is on", () => {
  const keys = (area: "all" | "agents" | "browser", privateValues?: boolean) =>
    visibleAgentPermissionGroups(area, { privateValues }).flatMap((group) => group.definitions.map((definition) => definition.key));
  const rows = ["privateValueFills", "privateValueCommands", "privateValuePaste", "privateValueTerminal", "privateValueRuns"];
  assert.deepEqual(keys("browser", true).filter((key) => rows.includes(key)), rows);
  assert.deepEqual(keys("all", true).filter((key) => rows.includes(key)), rows);
  for (const area of ["all", "browser"] as const) assert.equal(keys(area).some((key) => rows.includes(key)), false);
  assert.equal(keys("agents", true).some((key) => rows.includes(key)), false);
});

test("letting private-value programs into the agent's terminal is stored, and the default block is not", () => {
  const terminal = agentPermissionDefinition("privateValueTerminal");
  assert.equal(storedAgentPermissionDecision(terminal, null, "allow"), "allow");
  assert.equal(storedAgentPermissionDecision(terminal, null, "deny"), undefined);
  assert.equal(storedAgentPermissionDecision(agentPermissionDefinition("browserUploads"), null, "allow"), "allow");
  assert.equal(storedAgentPermissionDecision(agentPermissionDefinition("websites"), null, "allow"), undefined);
});
