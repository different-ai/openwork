import assert from "node:assert/strict";
import { test } from "node:test";
import { agentPermissionBlockedBy, visibleAgentPermissionGroups, visibleAgentPermissionTryKinds } from "./agent-permissions-presentation";

function visibleKeys(area: "all" | "agents" | "browser", enabled: boolean) {
  return visibleAgentPermissionGroups(area, enabled).flatMap((group) => group.definitions.map((definition) => definition.key));
}

test("flag off preserves the existing editor groups and rows", () => {
  assert.deepEqual(visibleAgentPermissionGroups("all", false).map((group) => group.label), ["Commands and files", "Web", "Skills and MCP servers"]);
  assert.deepEqual(visibleKeys("all", false), ["commands", "fileEdits", "websites", "webSearch", "localSkills", "localMcpServers"]);
});

test("flag on puts outside folders with files and computer use immediately after", () => {
  const groups = visibleAgentPermissionGroups("agents", true);
  assert.equal(groups[0]?.label, "Commands and files");
  assert.deepEqual(groups[0]?.definitions.map((definition) => definition.key), ["commands", "fileEdits", "externalFolders"]);
  assert.equal(groups[1]?.label, "Computer use");
  assert.deepEqual(groups[1]?.definitions.map((definition) => definition.key), ["computerUse", "appScripting"]);
  assert.equal(visibleKeys("agents", true).includes("websites"), false);
});

test("the browser tab stays unchanged with either flag state", () => {
  assert.deepEqual(visibleKeys("browser", true), ["websites"]);
  assert.deepEqual(visibleAgentPermissionGroups("browser", true), visibleAgentPermissionGroups("browser", false));
});

test("outside folder request is offered only on enabled Agents panels", () => {
  assert.deepEqual(visibleAgentPermissionTryKinds("all", false).map((kind) => kind.action), ["shell", "webfetch", "skill", "mcp"]);
  assert.deepEqual(visibleAgentPermissionTryKinds("agents", true).find((kind) => kind.action === "external_directory"), { action: "external_directory", label: "Outside folder", placeholder: "~/Documents/report.pdf" });
  assert.equal(visibleAgentPermissionTryKinds("browser", true).some((kind) => kind.action === "external_directory"), false);
});

test("scripting reports both own and inherited computer blocks; explicit team allow overrides Everyone", () => {
  assert.equal(agentPermissionBlockedBy("appScripting", { computerUse: { decision: "deny" } }, null)?.key, "computer-use");
  assert.equal(agentPermissionBlockedBy("appScripting", {}, { computerUse: { decision: "deny" } })?.key, "computer-use");
  assert.equal(agentPermissionBlockedBy("appScripting", { computerUse: { decision: "allow" } }, { computerUse: { decision: "deny" } }), null);
  assert.equal(agentPermissionBlockedBy("appScripting", { computerUse: { decision: "ask" } }, null), null);
  assert.equal(agentPermissionBlockedBy("appScripting", {}, null), null);
});

test("the existing commands block retains its reason and test id suffix", () => {
  assert.deepEqual(agentPermissionBlockedBy("commands", {}, { fileEdits: { decision: "deny" } }), { key: "edits", reason: "Blocked while Edit files is blocked, because any command can change files." });
  assert.equal(agentPermissionBlockedBy("commands", { fileEdits: { decision: "allow" } }, { fileEdits: { decision: "deny" } }), null);
});
