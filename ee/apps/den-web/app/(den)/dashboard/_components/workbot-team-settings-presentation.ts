import type { WorkbotSettings } from "@openwork/types/den/workbot-settings";
import {
  WORKBOT_TEAM_NAME_MAX_LENGTH,
  type WorkbotTeamSettingsTeam,
  type WorkbotTeamSettingsView,
  type WorkbotTeamSettingsWrite,
} from "@openwork/types/den/workbot-team-settings";
import type { DenComboboxOption } from "../../_components/ui/combobox";
import type { TeamScope } from "./team-scope";
import { isWorkbotModelListed, workbotModelName, workbotModelOptions } from "./workbot-model-options";

const BUILT_IN_DEFAULT_VALUE = "::default";

export const WORKBOT_CONFLICT_SETTING = "Workbot setting";

export const WORKBOT_AGENTS_LABEL = "Members' agents";

export function workbotAgentsShown(view: Pick<WorkbotTeamSettingsView, "organization">): boolean {
  return view.organization.agentEnabled !== undefined;
}

export function workbotTeamAgentsChanged(row: Pick<WorkbotTeamSettingsTeam, "agent">, policy: { inherit?: boolean } | undefined): boolean {
  if (policy?.inherit !== undefined) return !policy.inherit;
  return row.agent?.inherit === false;
}

export function workbotTeamAgentsSavedMessage(now: "everyone" | "own"): string {
  return now === "everyone"
    ? "Saved. This team uses Everyone's settings for members' agents."
    : "Saved. This team has its own settings for members' agents again.";
}

export function workbotTeamRow(view: WorkbotTeamSettingsView, team: { teamId: string; teamName: string }): WorkbotTeamSettingsTeam {
  return view.teams.find((entry) => entry.teamId === team.teamId) ?? {
    teamId: team.teamId,
    teamName: team.teamName,
    memberCount: 0,
    enabled: { inherit: true },
    model: { inherit: true },
    name: { inherit: true },
    conflictingMemberCount: 0,
  };
}

export function workbotTeamEnabled(view: WorkbotTeamSettingsView, row: WorkbotTeamSettingsTeam): boolean {
  return row.enabled.inherit ? view.organization.enabled : row.enabled.value;
}

export function workbotTeamModel(view: WorkbotTeamSettingsView, row: WorkbotTeamSettingsTeam): string | null {
  return row.model.inherit ? view.organization.model : row.model.value;
}

export function workbotOnOffLabel(enabled: boolean): string {
  return enabled ? "On" : "Off";
}

export function workbotOffLine(scope: TeamScope, teamsOn = 0): string {
  if (scope.kind === "team") return "Members of this team can't open Workbot and their agent stops messaging them.";
  return teamsOn > 0
    ? "Members can't open Workbot and their agent stops messaging them, unless their team has it on."
    : "Members can't open Workbot and their agent stops messaging them.";
}

export function workbotModelPickerValue(saved: string | null, settings: WorkbotSettings): string {
  return saved ?? settings.defaultModel ?? BUILT_IN_DEFAULT_VALUE;
}

export function workbotModelPickerChoice(value: string): string | null {
  return value === BUILT_IN_DEFAULT_VALUE ? null : value;
}

export function workbotModelPickerOptions(settings: WorkbotSettings, saved: string | null): DenComboboxOption[] {
  const value = workbotModelPickerValue(saved, settings);
  if (value === BUILT_IN_DEFAULT_VALUE) return [{ value, label: "Default" }, ...workbotModelOptions(settings, null, null)];
  return workbotModelOptions(settings, value, saved);
}

export function workbotTeamNameToSave(draft: string, shown: string): string | null {
  const next = draft.trim();
  if (!next || next.length > WORKBOT_TEAM_NAME_MAX_LENGTH) return null;
  return next === shown ? null : next;
}

function savedModelMessage(saved: string | null, settings: WorkbotSettings | undefined, named: (name: string) => string, unnamed: string): string {
  const id = saved ?? settings?.defaultModel ?? null;
  if (settings && id && (saved === null || isWorkbotModelListed(settings, id))) return named(workbotModelName(settings, id, saved));
  return unnamed;
}

export function workbotTeamSavedMessage(change: WorkbotTeamSettingsWrite, settings: WorkbotSettings | undefined): string {
  if (change.enabled) {
    if (change.enabled.inherit) return "Saved. This team uses Everyone's Workbot setting.";
    return `Saved. Workbot is ${change.enabled.value ? "on" : "off"} for this team.`;
  }
  if (change.model) {
    if (change.model.inherit) return "Saved. This team uses Everyone's model.";
    return savedModelMessage(
      change.model.value,
      settings,
      (name) => `Saved. This team's new messages use ${name}.`,
      change.model.value === null ? "Saved. This team uses the default model." : "Saved. This team uses its own model.",
    );
  }
  if (change.name) {
    return change.name.inherit ? "Saved. This team uses Everyone's name." : `Saved. This team's Workbot is called ${change.name.value}.`;
  }
  if (change.agent) return workbotTeamAgentsSavedMessage("everyone");
  return "Saved.";
}

export type WorkbotEveryoneChange = { enabled: boolean } | { model: string | null };

export function workbotEveryoneSavedMessage(change: WorkbotEveryoneChange, settings: WorkbotSettings | undefined): string {
  if ("enabled" in change) return `Saved. Workbot is ${change.enabled ? "on" : "off"} for Everyone.`;
  return savedModelMessage(change.model, settings, (name) => `Saved. New messages use ${name}.`, "Saved.");
}

export function workbotTeamCalendarChanged(view: Pick<WorkbotTeamSettingsView, "organization">, row: Pick<WorkbotTeamSettingsTeam, "agent">): boolean {
  return row.agent?.inherit === false && row.agent.calendar !== undefined && row.agent.calendar !== view.organization.agentCalendar;
}

export function workbotTeamsOnCount(view: Pick<WorkbotTeamSettingsView, "teams">): number {
  return view.teams.filter((team) => !team.enabled.inherit && team.enabled.value).length;
}

export function workbotTeamsOverridingCount(view: Pick<WorkbotTeamSettingsView, "teams">): number {
  return view.teams.filter((team) => !team.enabled.inherit || !team.model.inherit || !team.name.inherit || team.agent?.inherit === false).length;
}

export function workbotTeamsOverridingLabel(count: number): string {
  return count === 1 ? "1 team has its own Workbot settings." : `${count} teams have their own Workbot settings.`;
}
