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

/*
 * How Workbot's settings read on Members › Teams › Everyone (or a team) ›
 * Workbot: what each control shows, what a change saves, and the lines of
 * state around the rows.
 */

/** The picker value for the built-in default while its model isn't known (Workbot's models can't be reached). */
const BUILT_IN_DEFAULT_VALUE = "::default";

/** What differs for a member on two teams that disagree, for the conflict line. */
export const WORKBOT_CONFLICT_SETTING = "Workbot setting";

type WorkbotTeamSettingKey = "enabled" | "model" | "name";

/** A team the view doesn't list yet (just created) follows Everyone for everything. */
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

/** Whether Workbot is on for a team: its own choice, or Everyone's while it follows Everyone. */
export function workbotTeamEnabled(view: WorkbotTeamSettingsView, row: WorkbotTeamSettingsTeam): boolean {
  return row.enabled.inherit ? view.organization.enabled : row.enabled.value;
}

/** A team's saved model (null is the built-in default): its own, or Everyone's while it follows Everyone. */
export function workbotTeamModel(view: WorkbotTeamSettingsView, row: WorkbotTeamSettingsTeam): string | null {
  return row.model.inherit ? view.organization.model : row.model.value;
}

export function workbotOnOffLabel(enabled: boolean): string {
  return enabled ? "On" : "Off";
}

/** The line under the Workbot row while it is off. `teamsOn` counts the teams that turned it on for themselves. */
export function workbotOffLine(scope: TeamScope, teamsOn = 0): string {
  if (scope.kind === "team") return "Members of this team can't open Workbot and their agent stops messaging them.";
  return teamsOn > 0
    ? "Members can't open Workbot and their agent stops messaging them, unless their team has it on."
    : "Members can't open Workbot and their agent stops messaging them.";
}

/** The picker value of a saved model. The built-in default shows as that model, never as a separate "Default" entry. */
export function workbotModelPickerValue(saved: string | null, settings: WorkbotSettings): string {
  return saved ?? settings.defaultModel ?? BUILT_IN_DEFAULT_VALUE;
}

/** What picking a value saves. Den turns the built-in default's own id back into "the default". */
export function workbotModelPickerChoice(value: string): string | null {
  return value === BUILT_IN_DEFAULT_VALUE ? null : value;
}

/** The models the caller can choose; the saved model is never hidden, even when it is no longer offered. */
export function workbotModelPickerOptions(settings: WorkbotSettings, saved: string | null): DenComboboxOption[] {
  const value = workbotModelPickerValue(saved, settings);
  if (value === BUILT_IN_DEFAULT_VALUE) return [{ value, label: "Default" }, ...workbotModelOptions(settings, null, null)];
  return workbotModelOptions(settings, value, saved);
}

/** The name to save from what was typed, or null when there is nothing to save (empty, too long, or the name shown). */
export function workbotTeamNameToSave(draft: string, shown: string): string | null {
  const next = draft.trim();
  if (!next || next.length > WORKBOT_TEAM_NAME_MAX_LENGTH) return null;
  return next === shown ? null : next;
}

function savedModelMessage(saved: string | null, settings: WorkbotSettings | undefined, named: (name: string) => string, unnamed: string): string {
  const id = saved ?? settings?.defaultModel ?? null;
  if (settings && id && (saved === null || isWorkbotModelListed(settings, id))) return named(workbotModelName(settings, id, saved));
  // A model that can't be named here (no longer offered, or the list didn't load) is still saved.
  return unnamed;
}

/** The line shown after a team's save, next to Undo. */
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
  return "Saved.";
}

/** The line shown after a save on Everyone's page, next to Undo. */
export function workbotEveryoneSavedMessage(change: { enabled: boolean } | { model: string | null }, settings: WorkbotSettings | undefined): string {
  if ("enabled" in change) return `Saved. Workbot is ${change.enabled ? "on" : "off"} for Everyone.`;
  return savedModelMessage(change.model, settings, (name) => `Saved. New messages use ${name}.`, "Saved.");
}

/** The names of the teams with their own value for one setting, for the chip on Everyone's page. */
export function workbotTeamsChanged(view: Pick<WorkbotTeamSettingsView, "teams">, setting: WorkbotTeamSettingKey): string[] {
  return view.teams.filter((team) => !team[setting].inherit).map((team) => team.teamName);
}

/** How many teams turned Workbot on for themselves. */
export function workbotTeamsOnCount(view: Pick<WorkbotTeamSettingsView, "teams">): number {
  return view.teams.filter((team) => !team.enabled.inherit && team.enabled.value).length;
}

/** Teams with any Workbot setting of their own. */
export function workbotTeamsOverridingCount(view: Pick<WorkbotTeamSettingsView, "teams">): number {
  return view.teams.filter((team) => !team.enabled.inherit || !team.model.inherit || !team.name.inherit).length;
}

export function workbotTeamsOverridingLabel(count: number): string {
  return count === 1 ? "1 team has its own Workbot settings." : `${count} teams have their own Workbot settings.`;
}
