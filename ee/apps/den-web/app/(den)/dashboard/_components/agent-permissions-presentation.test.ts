import assert from "node:assert/strict";
import { test } from "node:test";
import { decideAgentPermission, resolveAgentPermissionRules, type AgentPermissionSettings } from "@openwork/types/den/agent-permissions";
import { agentPermissionBlockedBy, effectiveAgentPermissionSettings, visibleAgentPermissionGroups, visibleAgentPermissionTryKinds } from "./agent-permissions-presentation";

function visibleKeys(area: "all" | "agents" | "browser", harnessEnabled: boolean, computerUseEnabled: boolean) {
  return visibleAgentPermissionGroups(area, harnessEnabled, computerUseEnabled).flatMap((group) => group.definitions.map((definition) => definition.key));
}

test("harness flag off preserves the existing editor groups and rows", () => {
  for (const computerUseEnabled of [false, true]) {
    assert.deepEqual(visibleAgentPermissionGroups("all", false, computerUseEnabled).map((group) => group.label), ["Commands and files", "Web", "Skills and MCP servers"]);
    assert.deepEqual(visibleKeys("all", false, computerUseEnabled), ["commands", "fileEdits", "websites", "webSearch", "localSkills", "localMcpServers"]);
  }
});

test("both flags on put outside folders with files and computer use immediately after", () => {
  const groups = visibleAgentPermissionGroups("agents", true, true);
  assert.equal(groups[0]?.label, "Commands and files");
  assert.deepEqual(groups[0]?.definitions.map((definition) => definition.key), ["commands", "fileEdits", "externalFolders"]);
  assert.equal(groups[1]?.label, "Computer use");
  assert.deepEqual(groups[1]?.definitions.map((definition) => definition.key), ["computerUse", "appScripting"]);
  assert.equal(visibleKeys("agents", true, true).includes("websites"), false);
});

test("computer use off hides only its row, preserving scripting, outside folders and general rows", () => {
  for (const area of ["all", "agents", "browser"] satisfies ("all" | "agents" | "browser")[]) {
    assert.deepEqual(visibleKeys(area, true, false), visibleKeys(area, true, true).filter((key) => key !== "computerUse"));
    assert.deepEqual(visibleAgentPermissionTryKinds(area, true, false), visibleAgentPermissionTryKinds(area, true, true));
  }
  assert.deepEqual(visibleAgentPermissionGroups("agents", true, false)[1]?.definitions.map((definition) => definition.key), ["appScripting"]);
});

test("the browser tab stays unchanged with either flag state", () => {
  assert.deepEqual(visibleKeys("browser", true, true), ["websites"]);
  assert.deepEqual(visibleAgentPermissionGroups("browser", true, true), visibleAgentPermissionGroups("browser", false, false));
});

test("outside folder request is offered only on enabled Agents panels", () => {
  assert.deepEqual(visibleAgentPermissionTryKinds("all", false, true).map((kind) => kind.action), ["shell", "webfetch", "skill", "mcp"]);
  assert.deepEqual(visibleAgentPermissionTryKinds("agents", true, true).find((kind) => kind.action === "external_directory"), { action: "external_directory", label: "Outside folder", placeholder: "~/Documents/report.pdf" });
  assert.equal(visibleAgentPermissionTryKinds("browser", true, true).some((kind) => kind.action === "external_directory"), false);
});

test("scripting reports both own and inherited computer blocks; explicit team allow overrides Everyone", () => {
  assert.equal(agentPermissionBlockedBy("appScripting", { computerUse: { decision: "deny" } }, null)?.key, "computer-use");
  assert.equal(agentPermissionBlockedBy("appScripting", {}, { computerUse: { decision: "deny" } })?.key, "computer-use");
  assert.equal(agentPermissionBlockedBy("appScripting", { computerUse: { decision: "allow" } }, { computerUse: { decision: "deny" } }), null);
  assert.equal(agentPermissionBlockedBy("appScripting", { computerUse: { decision: "ask" } }, null), null);
  assert.equal(agentPermissionBlockedBy("appScripting", {}, null), null);
});

test("disabled computer use removes own and inherited scripting blocks from previews without losing saved settings", () => {
  const saved: AgentPermissionSettings = { computerUse: { decision: "deny" }, appScripting: { decision: "ask" }, externalFolders: { decision: "deny" }, commands: { decision: "ask" } };
  for (const computerUseEnabled of [false, true]) {
    const effective = effectiveAgentPermissionSettings(saved, computerUseEnabled);
    for (const inherited of [false, true]) {
      assert.equal(agentPermissionBlockedBy("appScripting", inherited ? {} : effective, inherited ? effective : null)?.key ?? null, computerUseEnabled ? "computer-use" : null);
      const rules = resolveAgentPermissionRules({ everyone: { source: "Everyone", settings: inherited ? effective : {} }, teams: [{ source: "Team", settings: inherited ? {} : effective }] });
      assert.equal(decideAgentPermission(rules, "script", ["*"]).effect, computerUseEnabled ? "deny" : "ask");
      assert.equal(decideAgentPermission(rules, "external_directory", ["~/Documents/report.pdf"]).effect, "deny");
      assert.equal(decideAgentPermission(rules, "shell", ["git status"]).effect, "ask");
    }
  }
  assert.equal(saved.computerUse?.decision, "deny");
  assert.equal(effectiveAgentPermissionSettings(saved, true), saved);
});

test("the existing commands block retains its reason and test id suffix", () => {
  assert.deepEqual(agentPermissionBlockedBy("commands", {}, { fileEdits: { decision: "deny" } }), { key: "edits", reason: "Blocked while Edit files is blocked, because any command can change files." });
  assert.equal(agentPermissionBlockedBy("commands", { fileEdits: { decision: "allow" } }, { fileEdits: { decision: "deny" } }), null);
});
