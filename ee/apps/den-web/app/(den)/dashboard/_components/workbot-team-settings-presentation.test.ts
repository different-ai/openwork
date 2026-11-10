import assert from "node:assert/strict";
import { test } from "node:test";
import { WORKBOT_DEFAULT_MODEL_NAME, type WorkbotSettings } from "@openwork/types/den/workbot-settings";
import type { WorkbotTeamSettingsView } from "@openwork/types/den/workbot-team-settings";
import { EVERYONE_SCOPE, scopeChipState, scopeConflictLine, teamScopeName, teamScopeOf, type TeamScope } from "./team-scope";
import { workbotDisplayName, workbotModelName, workbotModelOptions } from "./workbot-model-options";
import {
  WORKBOT_CONFLICT_SETTING,
  workbotEveryoneSavedMessage,
  workbotModelPickerChoice,
  workbotModelPickerOptions,
  workbotModelPickerValue,
  workbotOffLine,
  workbotOnOffLabel,
  workbotTeamEnabled,
  workbotTeamModel,
  workbotTeamNameToSave,
  workbotTeamRow,
  workbotTeamSavedMessage,
  workbotTeamsChanged,
  workbotTeamsOnCount,
  workbotTeamsOverridingCount,
  workbotTeamsOverridingLabel,
} from "./workbot-team-settings-presentation";

const LUNA = "openwork/openai/gpt-6-luna";
const SONNET = "gateway/claude-sonnet";
const settings: WorkbotSettings = {
  model: null,
  defaultModel: LUNA,
  models: [
    { id: LUNA, name: "GPT-6 Luna", provider: "openai" },
    { id: SONNET, name: "Claude Sonnet 4.5", provider: "anthropic" },
  ],
  modelAvailable: true,
  runnerReachable: true,
  gatewayModels: true,
};
const unreachable: WorkbotSettings = { ...settings, defaultModel: null, models: [], runnerReachable: false };

const support: TeamScope = { kind: "team", teamId: "team_a", teamName: "Support" };
const view: WorkbotTeamSettingsView = {
  organization: { model: SONNET, name: null, enabled: false },
  canEdit: true,
  teams: [
    { teamId: "team_a", teamName: "Support", memberCount: 4, enabled: { inherit: false, value: true }, model: { inherit: false, value: null }, name: { inherit: true }, conflictingMemberCount: 1 },
    { teamId: "team_b", teamName: "Sales", memberCount: 2, enabled: { inherit: true }, model: { inherit: true }, name: { inherit: false, value: "Ada" }, conflictingMemberCount: 0 },
    { teamId: "team_c", teamName: "Design", memberCount: 3, enabled: { inherit: true }, model: { inherit: true }, name: { inherit: true }, conflictingMemberCount: 0 },
    { teamId: "team_d", teamName: "Legal", memberCount: 1, enabled: { inherit: false, value: false }, model: { inherit: true }, name: { inherit: true }, conflictingMemberCount: 0 },
  ],
};

function labels(options: ReturnType<typeof workbotModelPickerOptions>) {
  return options.map((option) => option.label);
}

test("Workbot goes by the organization's brand name, unless it is unset or OpenWork", () => {
  assert.equal(workbotDisplayName(null), "Workbot");
  assert.equal(workbotDisplayName("  "), "Workbot");
  assert.equal(workbotDisplayName("OpenWork"), "Workbot");
  assert.equal(workbotDisplayName(" Ada "), "Ada");
  assert.equal(workbotDisplayName("x".repeat(60)).length, 40);
});

test("Everyone's picker still lists its saved model when it is no longer offered", () => {
  assert.deepEqual(workbotModelOptions(settings).map((option) => option.value), [LUNA, SONNET]);
  const gone = { ...settings, model: "gateway/retired" };
  assert.deepEqual(workbotModelOptions(gone)[0], { value: "gateway/retired", label: "Unavailable model", description: "Not available to you" });
  assert.equal(workbotModelName({ ...settings, models: [] }, LUNA), WORKBOT_DEFAULT_MODEL_NAME, "the built-in default keeps its name");
});

test("a scope is Everyone or one team, from a screen's team prop", () => {
  assert.deepEqual(teamScopeOf(null), EVERYONE_SCOPE);
  assert.deepEqual(teamScopeOf({ id: "team_a", name: "Support" }), support);
  assert.equal(teamScopeName(EVERYONE_SCOPE), "Everyone");
  assert.equal(teamScopeName(support), "Support");
});

test("a team's chip says From Everyone until the team has its own value", () => {
  assert.deepEqual(scopeChipState(support, { changed: false }), { label: "From Everyone", tone: "neutral" });
  assert.deepEqual(scopeChipState(support, { changed: true }), { label: "Changed for Support", tone: "info" });
});

test("Everyone's chip names the teams that changed a value, and is absent when none did", () => {
  assert.equal(scopeChipState(EVERYONE_SCOPE, { changed: false, changedTeams: [] }), null);
  assert.equal(scopeChipState(EVERYONE_SCOPE, { changed: false }), null);
  assert.deepEqual(scopeChipState(EVERYONE_SCOPE, { changed: false, changedTeams: ["Sales"] }), { label: "Changed for Sales", tone: "info" });
  assert.deepEqual(scopeChipState(EVERYONE_SCOPE, { changed: false, changedTeams: ["Sales", "Support", "Legal"] }), { label: "Changed for 3 teams", tone: "info" });

  assert.deepEqual(workbotTeamsChanged(view, "enabled"), ["Support", "Legal"]);
  assert.deepEqual(workbotTeamsChanged(view, "model"), ["Support"]);
  assert.deepEqual(workbotTeamsChanged(view, "name"), ["Sales"]);
});

test("the conflict line counts members, one or many, and says they get Everyone's", () => {
  assert.equal(scopeConflictLine(1, "model"), "1 member is also on a team with a different model, so they get Everyone's.");
  assert.equal(scopeConflictLine(3, WORKBOT_CONFLICT_SETTING), "3 members are also on a team with a different Workbot setting, so they get Everyone's.");
});

test("Workbot is on or off for a team: its own choice, or Everyone's while it follows Everyone", () => {
  assert.equal(workbotOnOffLabel(true), "On");
  assert.equal(workbotOnOffLabel(false), "Off");
  assert.equal(workbotTeamEnabled(view, workbotTeamRow(view, support)), true);
  assert.equal(workbotTeamEnabled(view, workbotTeamRow(view, { teamId: "team_b", teamName: "Sales" })), false);
  assert.equal(workbotTeamEnabled({ ...view, organization: { ...view.organization, enabled: true } }, workbotTeamRow(view, { teamId: "team_b", teamName: "Sales" })), true);
  assert.equal(workbotTeamEnabled(view, workbotTeamRow(view, { teamId: "team_d", teamName: "Legal" })), false);
});

test("the line under Workbot while it is off says what members lose", () => {
  assert.equal(workbotOffLine(support), "Members of this team can't open Workbot and their agent stops messaging them.");
  assert.equal(workbotOffLine(EVERYONE_SCOPE), "Members can't open Workbot and their agent stops messaging them.");
  assert.equal(workbotOffLine(EVERYONE_SCOPE, workbotTeamsOnCount(view)), "Members can't open Workbot and their agent stops messaging them, unless their team has it on.");
  assert.equal(workbotTeamsOnCount(view), 1);
});

test("a team's picker shows the model in use, with no entry for following Everyone", () => {
  const sales = workbotTeamRow(view, { teamId: "team_b", teamName: "Sales" });
  // Follows Everyone: Everyone's model is the value.
  assert.equal(workbotTeamModel(view, sales), SONNET);
  assert.equal(workbotModelPickerValue(workbotTeamModel(view, sales), settings), SONNET);
  assert.deepEqual(labels(workbotModelPickerOptions(settings, SONNET)), ["GPT-6 Luna", "Claude Sonnet 4.5"]);
  // Its own choice of the built-in default shows that model.
  assert.equal(workbotTeamModel(view, workbotTeamRow(view, support)), null);
  assert.equal(workbotModelPickerValue(null, settings), LUNA);
  assert.deepEqual(labels(workbotModelPickerOptions(settings, null)), ["GPT-6 Luna", "Claude Sonnet 4.5"]);
  assert.equal(workbotModelPickerChoice(SONNET), SONNET);
});

test("a saved model is never hidden, and the built-in default has an entry while models can't be reached", () => {
  assert.deepEqual(workbotModelPickerOptions(settings, "gateway/retired")[0], { value: "gateway/retired", label: "Unavailable model", description: "Not available to you" });
  const value = workbotModelPickerValue(null, unreachable);
  assert.deepEqual(labels(workbotModelPickerOptions(unreachable, null)), ["Default"]);
  assert.equal(workbotModelPickerChoice(value), null);
});

test("a name is saved trimmed, and only when it is 1 to 40 characters and not the name shown", () => {
  assert.equal(workbotTeamNameToSave("  Ada  ", "Workbot"), "Ada");
  assert.equal(workbotTeamNameToSave("   ", "Workbot"), null);
  assert.equal(workbotTeamNameToSave("x".repeat(41), "Workbot"), null);
  assert.equal(workbotTeamNameToSave("x".repeat(40), "Workbot"), "x".repeat(40));
  assert.equal(workbotTeamNameToSave("Ada ", "Ada"), null);
  assert.equal(workbotTeamNameToSave("Grace", "Ada"), "Grace");
  // Everyone's name, typed again, is nothing to save: the team keeps following Everyone.
  assert.equal(workbotTeamNameToSave("Workbot", "Workbot"), null);
});

test("the line after a team's save says what is now true", () => {
  assert.equal(workbotTeamSavedMessage({ enabled: { inherit: false, value: true } }, settings), "Saved. Workbot is on for this team.");
  assert.equal(workbotTeamSavedMessage({ enabled: { inherit: false, value: false } }, settings), "Saved. Workbot is off for this team.");
  assert.equal(workbotTeamSavedMessage({ enabled: { inherit: true } }, settings), "Saved. This team uses Everyone's Workbot setting.");
  assert.equal(workbotTeamSavedMessage({ model: { inherit: true } }, settings), "Saved. This team uses Everyone's model.");
  assert.equal(workbotTeamSavedMessage({ model: { inherit: false, value: SONNET } }, settings), "Saved. This team's new messages use Claude Sonnet 4.5.");
  assert.equal(workbotTeamSavedMessage({ model: { inherit: false, value: null } }, settings), "Saved. This team's new messages use GPT-6 Luna.");
  assert.equal(workbotTeamSavedMessage({ model: { inherit: false, value: "gateway/retired" } }, settings), "Saved. This team uses its own model.");
  assert.equal(workbotTeamSavedMessage({ model: { inherit: false, value: null } }, undefined), "Saved. This team uses the default model.");
  assert.equal(workbotTeamSavedMessage({ name: { inherit: true } }, settings), "Saved. This team uses Everyone's name.");
  assert.equal(workbotTeamSavedMessage({ name: { inherit: false, value: "Ada" } }, settings), "Saved. This team's Workbot is called Ada.");
});

test("the line after a save on Everyone's page says what is now true", () => {
  assert.equal(workbotEveryoneSavedMessage({ enabled: true }, settings), "Saved. Workbot is on for Everyone.");
  assert.equal(workbotEveryoneSavedMessage({ enabled: false }, undefined), "Saved. Workbot is off for Everyone.");
  assert.equal(workbotEveryoneSavedMessage({ model: SONNET }, settings), "Saved. New messages use Claude Sonnet 4.5.");
  assert.equal(workbotEveryoneSavedMessage({ model: null }, settings), "Saved. New messages use GPT-6 Luna.");
  assert.equal(workbotEveryoneSavedMessage({ model: SONNET }, undefined), "Saved.");
});

test("a team counts as having its own settings with any of the three, and an unlisted team follows Everyone", () => {
  assert.equal(workbotTeamsOverridingCount(view), 3);
  assert.equal(workbotTeamsOverridingLabel(1), "1 team has its own Workbot settings.");
  assert.equal(workbotTeamsOverridingLabel(2), "2 teams have their own Workbot settings.");
  assert.equal(workbotTeamRow(view, support).conflictingMemberCount, 1);
  assert.deepEqual(workbotTeamRow(view, { teamId: "team_new", teamName: "New" }), {
    teamId: "team_new", teamName: "New", memberCount: 0, enabled: { inherit: true }, model: { inherit: true }, name: { inherit: true }, conflictingMemberCount: 0,
  });
});
