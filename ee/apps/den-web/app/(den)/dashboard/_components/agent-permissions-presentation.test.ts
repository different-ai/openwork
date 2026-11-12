import assert from "node:assert/strict";
import { test } from "node:test";
import { agentPermissionDefaultDecision, agentPermissionDefinitions, agentPermissionMemberDecides, decideAgentPermission, resolveAgentPermissionRules, type AgentPermissionSettings } from "@openwork/types/den/agent-permissions";
import { teamOverrideSummary } from "./agent-permissions-data";
import { agentPermissionBlockedBy, agentPermissionChoiceOptions, agentPermissionChoiceValue, storedAgentPermissionDecision, effectiveAgentPermissionSettings, visibleAgentPermissionGroups, visibleAgentPermissionTryKinds } from "./agent-permissions-presentation";

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
  assert.deepEqual(groups[1]?.definitions.map((definition) => definition.key), ["computerUse", "computerFiles", "computerClipboard", "appScripting"]);
  assert.equal(visibleKeys("agents", true, true).includes("websites"), false);
});

test("computer use off hides its rows, preserving scripting, outside folders and general rows", () => {
  for (const area of ["all", "agents", "browser"] satisfies ("all" | "agents" | "browser")[]) {
    assert.deepEqual(visibleKeys(area, true, false), visibleKeys(area, true, true).filter((key) => !["computerUse", "computerFiles", "computerClipboard"].includes(key)));
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
  for (const key of ["computerFiles", "computerClipboard"]) {
    assert.equal(agentPermissionBlockedBy(key, {}, { computerUse: { decision: "deny" } })?.key, "computer-use");
    assert.equal(agentPermissionBlockedBy(key, { computerUse: { decision: "ask" } }, null), null);
  }
});

test("copy and paste is a switch, and moving files offers Ask first", () => {
  const options = (key: string) => agentPermissionChoiceOptions(agentPermissionDefinitions.find((definition) => definition.key === key)!, null).map((option) => option.value);
  assert.deepEqual(options("computerFiles"), ["allow", "ask", "deny"]);
  assert.deepEqual(options("computerClipboard"), ["allow", "deny"]);
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

test("browser uploads have an independent gate and reuse the website editor and request preview", () => {
  for (const harness of [false, true]) {
    assert.deepEqual(visibleAgentPermissionGroups("browser", harness, false, true).flatMap(group => group.definitions.map(definition => definition.key)), ["websites", "browserUploads"]);
    assert.deepEqual(visibleAgentPermissionTryKinds("browser", harness, false, true).map(kind => kind.action), ["webfetch", "browser_upload"]);
    assert.equal(visibleAgentPermissionGroups("agents", harness, true, true).some(group => group.definitions.some(definition => definition.key === "browserUploads")), false);
  }
  for (const definition of agentPermissionDefinitions) {
    assert.equal(agentPermissionDefaultDecision(definition.key), agentPermissionMemberDecides(definition.key) ? "ask" : "allow");
    assert.equal(storedAgentPermissionDecision(definition, null, "allow"), agentPermissionMemberDecides(definition.key) ? "allow" : undefined);
    assert.equal(storedAgentPermissionDecision(definition, null, "ask"), "ask");
    assert.equal(storedAgentPermissionDecision(definition, "Test team", "allow"), "allow");
  }
});

test("upload defaults are distinct from explicit Ask without changing existing controls", () => {
  for (const definition of agentPermissionDefinitions) {
    const everyoneOptions = agentPermissionChoiceOptions(definition, null);
    const teamOptions = agentPermissionChoiceOptions(definition, "Reviewers");
    if (agentPermissionMemberDecides(definition.key)) {
      assert.deepEqual(everyoneOptions, [{ value: "inherit", label: "Member decides" }, { value: "allow", label: "Allow" }, { value: "ask", label: "Ask first" }, { value: "deny", label: "Block" }]);
      assert.deepEqual(teamOptions[0], { value: "inherit", label: "Use Everyone's" });
      assert.equal(agentPermissionChoiceValue(definition, undefined, "ask"), "inherit");
      assert.equal(agentPermissionChoiceValue(definition, undefined, "deny"), "inherit");
      assert.equal(agentPermissionChoiceValue(definition, "ask", "ask"), "ask");
      const setting = { decision: "ask", allow: ["files.example.test"], block: ["private.example.test"] };
      const inherited = { ...setting, decision: storedAgentPermissionDecision(definition, null, undefined) };
      assert.deepEqual(inherited, { decision: undefined, allow: setting.allow, block: setting.block });
    } else {
      assert.deepEqual(everyoneOptions, teamOptions);
      assert.equal(everyoneOptions.some(option => option.value === "inherit"), false);
      assert.equal(agentPermissionChoiceValue(definition, undefined, "ask"), "ask");
    }
  }
});

test("file sends have their own gate, sit with the other file permissions and let the member decide by default", () => {
  const keys = (area: "all" | "agents" | "browser", fileSends: boolean) =>
    visibleAgentPermissionGroups(area, true, true, true, fileSends).flatMap(group => group.definitions.map(definition => definition.key));
  for (const area of ["all", "agents", "browser"] satisfies ("all" | "agents" | "browser")[]) {
    assert.equal(keys(area, false).includes("fileSends"), false);
    assert.equal(visibleAgentPermissionTryKinds(area, true, true, true, false).some(kind => kind.action === "file_send"), false);
  }
  assert.equal(keys("agents", true).includes("fileSends"), true);
  assert.equal(keys("browser", true).includes("fileSends"), false);
  assert.equal(visibleAgentPermissionTryKinds("agents", true, true, true, true).some(kind => kind.action === "file_send"), true);
  assert.deepEqual([...agentPermissionDefinitions].filter(definition => agentPermissionMemberDecides(definition.key)).map(definition => definition.key), ["browserUploads", "fileSends"]);
});

test("the existing commands block retains its reason and test id suffix", () => {
  assert.deepEqual(agentPermissionBlockedBy("commands", {}, { fileEdits: { decision: "deny" } }), { key: "edits", reason: "Blocked while Edit files is blocked, because any command can change files." });
  assert.equal(agentPermissionBlockedBy("commands", { fileEdits: { decision: "allow" } }, { fileEdits: { decision: "deny" } }), null);
});

test("the Teams list counts a team's own permissions as changes, and nothing while it follows Everyone", () => {
  const team = { scopeId: "team_sales", teamId: "team_sales", name: "Sales", memberCount: 2 };
  assert.equal(teamOverrideSummary({ ...team, settings: { commands: { decision: "ask" } }, updatedAt: "2026-01-01T00:00:00.000Z" }), "1 change");
  assert.equal(teamOverrideSummary({ ...team, settings: { commands: { decision: "ask" }, fileEdits: { decision: "deny" } }, updatedAt: "2026-01-01T00:00:00.000Z" }), "2 changes");
  assert.equal(teamOverrideSummary({ ...team, settings: {}, updatedAt: null }), null);
  assert.equal(teamOverrideSummary(undefined), null);
});
