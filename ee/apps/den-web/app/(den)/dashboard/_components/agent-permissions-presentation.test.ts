import assert from "node:assert/strict";
import { test } from "node:test";
import { agentPermissionDefaultDecision, agentPermissionDefinitions, agentPermissionMemberDecides, decideAgentPermission, resolveAgentPermissionRules, type AgentPermissionSettings } from "@openwork/types/den/agent-permissions";
import { teamOverrideSummary } from "./agent-permissions-data";
import { agentPermissionBlockedBy, agentPermissionChoiceOptions, agentPermissionChoiceValue, storedAgentPermissionDecision, visibleAgentPermissionGroups, visibleAgentPermissionTryKinds } from "./agent-permissions-presentation";

function visibleKeys(area: "all" | "agents" | "browser") {
  return visibleAgentPermissionGroups(area).flatMap((group) => group.definitions.map((definition) => definition.key));
}

test("agent panels always include harness controls, outside folders and computer use", () => {
  const groups = visibleAgentPermissionGroups("agents");
  assert.equal(groups[0]?.label, "Commands and files");
  assert.deepEqual(groups[0]?.definitions.map((definition) => definition.key), ["commands", "fileEdits", "externalFolders", "fileSends"]);
  assert.equal(groups[1]?.label, "Computer use");
  assert.deepEqual(groups[1]?.definitions.map((definition) => definition.key), ["computerUse", "computerFiles", "computerClipboard", "appScripting"]);
  assert.equal(visibleKeys("agents").includes("websites"), false);
});

test("the browser tab always includes website uploads, not outside folders", () => {
  assert.deepEqual(visibleKeys("browser"), ["websites", "browserUploads"]);
  assert.deepEqual(visibleAgentPermissionTryKinds("browser").map((kind) => kind.action), ["webfetch", "browser_upload"]);
  assert.deepEqual(visibleAgentPermissionTryKinds("agents").find((kind) => kind.action === "external_directory"), { action: "external_directory", label: "Outside folder", placeholder: "~/Documents/report.pdf" });
  assert.equal(visibleAgentPermissionTryKinds("browser").some((kind) => kind.action === "external_directory"), false);
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

test("saved computer restrictions always apply to request previews", () => {
  const settings: AgentPermissionSettings = { computerUse: { decision: "deny" }, appScripting: { decision: "ask" }, externalFolders: { decision: "deny" }, commands: { decision: "ask" } };
  for (const inherited of [false, true]) {
    assert.equal(agentPermissionBlockedBy("appScripting", inherited ? {} : settings, inherited ? settings : null)?.key, "computer-use");
    const rules = resolveAgentPermissionRules({ everyone: { source: "Everyone", settings: inherited ? settings : {} }, teams: [{ source: "Team", settings: inherited ? {} : settings }] });
    assert.equal(decideAgentPermission(rules, "script", ["*"]).effect, "deny");
    assert.equal(decideAgentPermission(rules, "external_directory", ["~/Documents/report.pdf"]).effect, "deny");
    assert.equal(decideAgentPermission(rules, "shell", ["git status"]).effect, "ask");
  }
});

test("uploads reuse website controls and retain member-decided defaults", () => {
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

test("file sends sit with file permissions and let the member decide by default", () => {
  const keys = (area: "all" | "agents" | "browser") =>
    visibleAgentPermissionGroups(area).flatMap(group => group.definitions.map(definition => definition.key));
  assert.equal(keys("agents").includes("fileSends"), true);
  assert.equal(keys("all").includes("fileSends"), true);
  assert.equal(keys("browser").includes("fileSends"), false);
  assert.equal(visibleAgentPermissionTryKinds("agents").some(kind => kind.action === "file_send"), true);
  assert.equal(visibleAgentPermissionTryKinds("browser").some(kind => kind.action === "file_send"), false);
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
