import assert from "node:assert/strict";
import { test } from "node:test";
import { WORKBOT_DEFAULT_MODEL_NAME, type WorkbotSettings } from "@openwork/types/den/workbot-settings";
import type { WorkbotTeamSettingsView } from "@openwork/types/den/workbot-team-settings";
import { EVERYONE_SCOPE, scopeChipState, scopeConflictLine, teamScopeName, teamScopeOf, type TeamScope } from "./team-scope";
import { workbotDisplayName, workbotModelName, workbotModelOptions } from "./workbot-model-options";
import {
  WORKBOT_AGENTS_LABEL,
  WORKBOT_CONFLICT_SETTING,
  workbotAgentsShown,
  workbotEveryoneSavedMessage,
  workbotModelPickerChoice,
  workbotModelPickerOptions,
  workbotModelPickerValue,
  workbotOffLine,
  workbotOnOffLabel,
  workbotTeamAgentsChanged,
  workbotTeamAgentsSavedMessage,
  workbotTeamEnabled,
  workbotTeamModel,
  workbotTeamNameToSave,
  workbotTeamRow,
  workbotTeamSavedMessage,
  workbotTeamCalendarChanged,
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

test("Everyone's page has no chip, whatever its teams changed: Everyone's values are the default", () => {
  assert.equal(scopeChipState(EVERYONE_SCOPE, { changed: false }), null);
  assert.equal(scopeChipState(EVERYONE_SCOPE, { changed: true }), null);
});

test("the conflict line counts members, one or many, and says they get Everyone's, whichever Workbot setting differs", () => {
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

test("a team counts as having its own settings with any of them, and an unlisted team follows Everyone", () => {
  assert.equal(workbotTeamsOverridingCount(view), 3);
  assert.equal(workbotTeamsOverridingLabel(1), "1 team has its own Workbot settings.");
  assert.equal(workbotTeamsOverridingLabel(2), "2 teams have their own Workbot settings.");
  assert.equal(workbotTeamRow(view, support).conflictingMemberCount, 1);
  assert.deepEqual(workbotTeamRow(view, { teamId: "team_new", teamName: "New" }), {
    teamId: "team_new", teamName: "New", memberCount: 0, enabled: { inherit: true }, model: { inherit: true }, name: { inherit: true }, conflictingMemberCount: 0,
  });
});

/** The same view with members' agents available: off for Everyone, Design with its own settings and agents on, the rest following Everyone. */
const withAgents: WorkbotTeamSettingsView = {
  ...view,
  organization: { ...view.organization, agentEnabled: false },
  teams: view.teams.map((team) => ({ ...team, agent: team.teamName === "Design" ? { inherit: false, enabled: true } : { inherit: true, enabled: false } })),
};

test("a team's Calendar row is marked changed only when its Calendar choice differs from Everyone's, not whenever it has its own agent settings", () => {
  const calendars: WorkbotTeamSettingsView = {
    ...view,
    organization: { ...view.organization, agentEnabled: true, agentCalendar: "everyone" },
    teams: view.teams.map((team) => ({
      ...team,
      // Sales has its own settings with the same Calendar choice; Design chose differently; the rest follow Everyone.
      agent: team.teamName === "Sales" ? { inherit: false, enabled: true, calendar: "everyone" as const }
        : team.teamName === "Design" ? { inherit: false, enabled: true, calendar: "members" as const }
          : { inherit: true, enabled: true, calendar: "everyone" as const },
    })),
  };
  const row = (teamName: string) => calendars.teams.find((team) => team.teamName === teamName) ?? { agent: undefined };
  assert.equal(workbotTeamCalendarChanged(calendars, row("Sales")), false);
  assert.equal(workbotTeamCalendarChanged(calendars, row("Design")), true);
  assert.equal(workbotTeamCalendarChanged(calendars, row("Support")), false);
  // A server from before the field says nothing about the calendar: not marked.
  assert.equal(workbotTeamCalendarChanged(withAgents, withAgents.teams.find((team) => team.teamName === "Design") ?? { agent: undefined }), false);
  assert.equal(workbotTeamCalendarChanged(view, { agent: undefined }), false);
});

test("the Members' agents section is there only while the view carries it", () => {
  assert.equal(WORKBOT_AGENTS_LABEL, "Members' agents");
  assert.equal(workbotAgentsShown(view), false);
  assert.equal(workbotAgentsShown(withAgents), true);
});

test("a team's chip for members' agents follows its loaded settings, and the list until they load", () => {
  const design = workbotTeamRow(withAgents, { teamId: "team_c", teamName: "Design" });
  assert.equal(workbotTeamAgentsChanged(design, undefined), true);
  assert.equal(workbotTeamAgentsChanged(workbotTeamRow(withAgents, support), undefined), false);
  // A control was just saved: the team has its own settings before the list is read again.
  assert.equal(workbotTeamAgentsChanged(workbotTeamRow(withAgents, support), { inherit: false }), true);
  assert.equal(workbotTeamAgentsChanged(design, { inherit: true }), false);
  // A team the list doesn't carry yet follows Everyone.
  assert.equal(workbotTeamAgentsChanged(workbotTeamRow(withAgents, { teamId: "team_new", teamName: "New" }), undefined), false);
});

test("the count of teams with their own settings includes members' agents", () => {
  // Design has only its members' agents of its own.
  assert.equal(workbotTeamsOverridingCount(withAgents), 4);
});

test("the line after Use Everyone's for members' agents, and after its Undo, says what is now true", () => {
  assert.equal(workbotTeamSavedMessage({ agent: { inherit: true } }, settings), "Saved. This team uses Everyone's settings for members' agents.");
  assert.equal(workbotTeamAgentsSavedMessage("everyone"), "Saved. This team uses Everyone's settings for members' agents.");
  assert.equal(workbotTeamAgentsSavedMessage("own"), "Saved. This team has its own settings for members' agents again.");
});
