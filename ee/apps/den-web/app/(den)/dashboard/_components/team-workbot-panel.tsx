"use client";

import Link from "next/link";
import { useId, useState, type FormEvent } from "react";
import type { WorkbotSettings } from "@openwork/types/den/workbot-settings";
import { WORKBOT_TEAM_NAME_MAX_LENGTH, type WorkbotTeamSettingsTeam, type WorkbotTeamSettingsWrite } from "@openwork/types/den/workbot-team-settings";
import { DenButton } from "../../_components/ui/button";
import { DenCard } from "../../_components/ui/card";
import { DenCombobox } from "../../_components/ui/combobox";
import { DenInput } from "../../_components/ui/input";
import { DenNotice } from "../../_components/ui/notice";
import { DenSelect } from "../../_components/ui/select";
import { DenSkeleton } from "../../_components/ui/skeleton";
import { DenSwitch } from "../../_components/ui/switch";
import {
  getBrandAppearanceRoute,
  getMcpConnectionsRoute,
  getOrgAccessFlags,
  getWorkbotSettingsRoute,
  orgFeatureEnabled,
  type DenOrgContext,
} from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { HelpTip } from "./help-tip";
import { ConflictLine, ReadOnlyNotice, SavedUndoLine, ScopeChip, SettingRow, UseEveryonesButton } from "./scoped-setting";
import type { TeamScope } from "./team-scope";
import { AGENT_HEALTH_ANCHOR, agentPolicyRestoreChange } from "./workbot-agent-scope";
import { workbotDisplayName } from "./workbot-model-options";
import { useSaveWorkbotProactive, useWorkbotProactive, type AgentPolicyView } from "./workbot-proactive-data";
import { WorkbotProactiveSection } from "./workbot-proactive-section";
import { useSaveWorkbotModel, useSaveWorkbotStepLimit, useWorkbotSettings } from "./workbot-settings-data";
import { WorkbotSettingsTabs, workbotSettingsTabsEnabled } from "./workbot-settings-tabs";
import { WORKBOT_SETTING_HELP, workbotSettingsParts, type WorkbotAgentsPart, type WorkbotSettingsParts, type WorkbotSettingsTab } from "./workbot-settings-tabs-model";
import { STEP_LIMIT_HELP, stepLimitChoices, stepLimitLabel, stepLimitValue } from "./workbot-step-limit-options";
import { useSaveWorkbotEveryoneSettings, useSaveWorkbotTeamSettings, useWorkbotTeamSettings } from "./workbot-team-settings-data";
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
  workbotTeamStepLimit,
  workbotTeamsChanged,
  workbotTeamsOnCount,
  type WorkbotEveryoneChange,
} from "./workbot-team-settings-presentation";

type TeamSettingsQuery = ReturnType<typeof useWorkbotTeamSettings>;
type ModelsQuery = ReturnType<typeof useWorkbotSettings>;
type RowsProps = { orgId: string; orgSlug: string | null; view: TeamSettingsQuery; models: ModelsQuery; canEdit: boolean; parts: WorkbotSettingsParts; help: boolean };
type TeamOnlyScope = Extract<TeamScope, { kind: "team" }>;

/** The Workbot tab shows with settings per team on, for people who can view Workbot's settings. */
export function workbotTabVisible(orgContext: DenOrgContext | null): boolean {
  if (!orgContext || !orgFeatureEnabled(orgContext, "workbotTeamSettings")) return false;
  const access = getOrgAccessFlags(orgContext.currentMember.role, orgContext.currentMember.isOwner, orgContext.currentMember.permissions);
  return access.canViewModelsSettings || access.canManageModelsSettings;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

/**
 * Members › Teams › Everyone (or a team) › Workbot: whether Workbot is on, the
 * model it starts on, its step limit (while the step limit is on), the name
 * it goes by and, while members' agents are available, how they work.
 * Everyone's page holds the values every team follows until it changes one
 * for its own members.
 */
export function WorkbotPanel({ scope }: { scope: TeamScope }) {
  const { orgContext, orgId: scopedOrgId, orgSlug } = useOrgDashboard();
  const orgId = scopedOrgId ?? "";
  const visible = workbotTabVisible(orgContext);
  const view = useWorkbotTeamSettings(orgId, visible);
  // The same read as Manage › Workbot: the models this person can choose, and their names.
  const models = useWorkbotSettings(orgId, visible && Boolean(orgId));
  const [tab, setTab] = useState<WorkbotSettingsTab>("general");
  if (!orgContext || !visible) return null;
  // Tabs split Workbot's own settings from members' agents and what they read, where there are agents to show.
  const tabs = workbotSettingsTabsEnabled(orgContext) && Boolean(view.data && workbotAgentsShown(view.data));
  const parts = workbotSettingsParts(tabs, tab);
  // An "i" beside each row's label saying what the setting does.
  const help = workbotSettingsTabsEnabled(orgContext);
  const canManage = getOrgAccessFlags(orgContext.currentMember.role, orgContext.currentMember.isOwner, orgContext.currentMember.permissions).canManageModelsSettings;
  const canEdit = canManage && (view.data?.canEdit ?? true);

  return (
    <div className="grid gap-3" data-testid="team-workbot">
      {canEdit ? null : <ReadOnlyNotice permission="inference.manage" />}
      {view.isError ? (
        <DenNotice
          tone="error"
          message={errorMessage(view.error, "Couldn't load Workbot's settings.")}
          action={<DenButton variant="secondary" size="sm" loading={view.isFetching} onClick={() => void view.refetch()}>Try again</DenButton>}
        />
      ) : null}
      {!view.isError && models.isError ? (
        <DenNotice
          tone="error"
          message={errorMessage(models.error, "Couldn't load Workbot's models.")}
          action={<DenButton variant="secondary" size="sm" loading={models.isFetching} onClick={() => void models.refetch()}>Try again</DenButton>}
        />
      ) : null}
      {!view.isError && models.data && !models.data.runnerReachable ? (
        <DenNotice
          tone="error"
          message="Couldn't reach Workbot's models, so the model can't be changed right now."
          action={<DenButton variant="secondary" size="sm" loading={models.isFetching} onClick={() => void models.refetch()}>Try again</DenButton>}
        />
      ) : null}
      {tabs ? <WorkbotSettingsTabs activeTab={tab} onChange={setTab} /> : null}
      {scope.kind === "team"
        ? <TeamWorkbotSettings key={scope.teamId} scope={scope} orgId={orgId} orgSlug={orgSlug} view={view} models={models} canEdit={canEdit} parts={parts} help={help} />
        : <EveryoneWorkbotSettings scope={scope} orgId={orgId} orgSlug={orgSlug} view={view} models={models} canEdit={canEdit} parts={parts} help={help} />}
    </div>
  );
}

function SwitchSkeleton() {
  return <DenSkeleton className="h-6 w-10 rounded-full" data-testid="team-workbot-skeleton" />;
}

function FieldSkeleton({ className }: { className: string }) {
  return <DenSkeleton className={`h-10 max-w-full ${className}`} data-testid="team-workbot-skeleton" />;
}

function Unavailable() {
  return <span className="text-[13px] text-gray-500">Unavailable</span>;
}

/** On or off, said in words beside the switch. */
function WorkbotSwitch({ checked, disabled, onChange }: { checked: boolean; disabled: boolean; onChange: (checked: boolean) => void }) {
  return (
    <span className="flex shrink-0 items-center gap-2">
      <span className="text-[13px] text-gray-600" aria-hidden="true" data-testid="team-workbot-enabled-label">{workbotOnOffLabel(checked)}</span>
      <DenSwitch aria-label="Workbot" checked={checked} disabled={disabled} onChange={onChange} testId="team-workbot-enabled" />
    </span>
  );
}

/** The model in use, saved as soon as another is picked. `saved` null is the built-in default. */
function WorkbotModelPicker({ saved, settings, disabled, onPick }: {
  saved: string | null;
  settings: WorkbotSettings;
  disabled: boolean;
  onPick: (model: string | null) => void;
}) {
  const value = workbotModelPickerValue(saved, settings);
  return (
    <div className="w-80 min-w-0 max-w-full" data-testid="team-workbot-model-picker">
      <DenCombobox
        ariaLabel="Default model"
        value={value}
        options={workbotModelPickerOptions(settings, saved)}
        disabled={disabled || !settings.runnerReachable}
        placeholder="Choose a model"
        searchPlaceholder="Search models"
        emptyLabel="No models match"
        onChange={(next) => {
          if (next !== value) onPick(workbotModelPickerChoice(next));
        }}
      />
    </div>
  );
}

/** The step limit in use, saved as soon as another is picked. `saved` null is the deployment's default. */
function WorkbotStepLimitSelect({ labelId, saved, disabled, onPick }: {
  labelId: string;
  saved: number | null;
  disabled: boolean;
  onPick: (maxSteps: number | null) => void;
}) {
  const choices = stepLimitChoices(saved);
  return (
    <div className="w-40" title={STEP_LIMIT_HELP} data-testid="team-workbot-step-limit">
      <DenSelect
        aria-labelledby={labelId}
        menuWidth="trigger"
        value={stepLimitValue(saved)}
        disabled={disabled}
        onChange={(event) => {
          const choice = choices.find((entry) => stepLimitValue(entry) === event.target.value);
          if (choice !== undefined && choice !== saved) onPick(choice);
        }}
      >
        {choices.map((choice) => (
          <option key={stepLimitValue(choice)} value={stepLimitValue(choice)}>{stepLimitLabel(choice)}</option>
        ))}
      </DenSelect>
    </div>
  );
}

/** Everyone: Workbot on or off, its default model and its step limit, saved on change. The name is the organization's brand name. */
function EveryoneWorkbotSettings({ scope, orgId, orgSlug, view, models, canEdit, parts, help }: RowsProps & { scope: TeamScope }) {
  const ids = { enabled: useId(), model: useId(), maxSteps: useId(), name: useId() };
  const saveEveryone = useSaveWorkbotEveryoneSettings(orgId);
  const saveModel = useSaveWorkbotModel(orgId);
  const saveStepLimit = useSaveWorkbotStepLimit(orgId);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ change: WorkbotEveryoneChange; undo: WorkbotEveryoneChange } | null>(null);
  const pending = saveEveryone.isPending || saveModel.isPending || saveStepLimit.isPending;
  const data = view.data;
  const settings = models.data;
  // Absent while the step limit isn't on: no row.
  const everyonesMaxSteps = data?.organization.maxSteps;

  async function store(change: WorkbotEveryoneChange, undo: WorkbotEveryoneChange) {
    setSaveError(null);
    setSaved(null);
    try {
      if ("enabled" in change) await saveEveryone.mutateAsync(change);
      else if ("maxSteps" in change) await saveStepLimit.mutateAsync(change.maxSteps);
      else await saveModel.mutateAsync(change.model);
      setSaved({ change, undo });
    } catch (error) {
      setSaveError(errorMessage(error, "Couldn't save Workbot's settings. Try again."));
    }
  }

  return (
    <>
      {parts.general ? (<>
      <DenCard size="comfortable" className="divide-y divide-gray-100 overflow-hidden !p-0" data-section="everyone-workbot-settings">
        <SettingRow
          label="Workbot"
          labelId={ids.enabled}
          aside={help ? <HelpTip label="Workbot">{WORKBOT_SETTING_HELP.enabled}</HelpTip> : null}
          stateLine={data && !data.organization.enabled ? <span data-testid="team-workbot-off">{workbotOffLine(scope, workbotTeamsOnCount(data))}</span> : null}
        >
          {view.isError ? <Unavailable /> : !data ? <SwitchSkeleton /> : (
            <>
              <ScopeChip scope={scope} changed={false} changedTeams={workbotTeamsChanged(data, "enabled")} />
              <WorkbotSwitch
                checked={data.organization.enabled}
                disabled={!canEdit || pending}
                onChange={(enabled) => void store({ enabled }, { enabled: data.organization.enabled })}
              />
            </>
          )}
        </SettingRow>
        <SettingRow label="Default model" labelId={ids.model} aside={help ? <HelpTip label="Default model">{WORKBOT_SETTING_HELP.model}</HelpTip> : null}>
          {view.isError || models.isError ? <Unavailable /> : !data || !settings ? <FieldSkeleton className="w-80" /> : (
            <>
              <ScopeChip scope={scope} changed={false} changedTeams={workbotTeamsChanged(data, "model")} />
              {/* The same value and save as Manage › Workbot, so the two pages never disagree. */}
              <WorkbotModelPicker
                saved={settings.model}
                settings={settings}
                disabled={!canEdit || pending}
                onPick={(model) => void store({ model }, { model: settings.model })}
              />
            </>
          )}
        </SettingRow>
        {data && everyonesMaxSteps !== undefined ? (
          <SettingRow label="Step limit" labelId={ids.maxSteps} aside={help ? <HelpTip label="Step limit">{STEP_LIMIT_HELP}</HelpTip> : null}>
            <ScopeChip scope={scope} changed={false} changedTeams={workbotTeamsChanged(data, "maxSteps")} />
            {/* The same value and save as Manage › Workbot. The pick shows while it saves. */}
            <WorkbotStepLimitSelect
              labelId={ids.maxSteps}
              saved={saveStepLimit.isPending && saveStepLimit.variables !== undefined ? saveStepLimit.variables : everyonesMaxSteps}
              disabled={!canEdit || pending}
              onPick={(maxSteps) => void store({ maxSteps }, { maxSteps: everyonesMaxSteps })}
            />
          </SettingRow>
        ) : null}
        <SettingRow label="Name" labelId={ids.name} aside={help ? <HelpTip label="Name">{WORKBOT_SETTING_HELP.name}</HelpTip> : null}>
          {view.isError ? <Unavailable /> : !data ? <FieldSkeleton className="w-40" /> : (
            <>
              <ScopeChip scope={scope} changed={false} changedTeams={workbotTeamsChanged(data, "name")} />
              <span className="text-[13px] text-gray-900" data-testid="team-workbot-everyone-name">{workbotDisplayName(data.organization.name)}</span>
              <Link
                href={getBrandAppearanceRoute(orgSlug)}
                className="rounded text-[13px] text-gray-500 underline-offset-2 hover:text-gray-900 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900"
              >
                Change in Brand appearance
              </Link>
            </>
          )}
        </SettingRow>
      </DenCard>

      {saveError ? <p role="alert" className="px-1 text-[13px] text-red-700">{saveError}</p> : null}
      {saved ? (
        <SavedUndoLine message={workbotEveryoneSavedMessage(saved.change, settings)} pending={pending} onUndo={() => void store(saved.undo, saved.change)} />
      ) : null}
      </>) : null}
      {parts.agents && data && workbotAgentsShown(data) ? (
        <EveryoneMembersAgents scope={scope} orgId={orgId} orgSlug={orgSlug} changedTeams={workbotTeamsChanged(data, "agent")} canEdit={canEdit} show={parts.agents} />
      ) : null}
    </>
  );
}

const quietLinkClass = "shrink-0 rounded text-[12px] text-gray-500 underline-offset-2 hover:text-gray-900 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900";

/** Everyone's members' agents: the same controls, value and save as Manage › Workbot, so the two pages never disagree. */
function EveryoneMembersAgents({ scope, orgId, orgSlug, changedTeams, canEdit, show }: {
  show: WorkbotAgentsPart;
  scope: TeamScope;
  orgId: string;
  orgSlug: string | null;
  changedTeams: readonly string[];
  canEdit: boolean;
}) {
  return (
    <div className={show === "all" ? "mt-3" : undefined} data-testid="team-workbot-agents">
      <WorkbotProactiveSection
        orgId={orgId}
        scope={scope}
        show={show}
        canManage={canEdit}
        connectorsHref={getMcpConnectionsRoute(orgSlug)}
        headerAside={(
          <>
            <ScopeChip scope={scope} changed={false} changedTeams={changedTeams} />
            {/* The counts cover every member whatever their team, so they stay on Manage › Workbot. */}
            <Link href={`${getWorkbotSettingsRoute(orgSlug)}#${AGENT_HEALTH_ANCHOR}`} className={quietLinkClass}>See the last 7 days</Link>
          </>
        )}
      />
    </div>
  );
}

/**
 * A team's members' agents: Everyone's settings until the team changes a control, which gives the team its own
 * copy of all of them. "Use Everyone's" removes that copy; Undo saves it back.
 */
function TeamMembersAgents({ scope, orgId, orgSlug, row, canEdit, show }: {
  show: WorkbotAgentsPart;
  scope: TeamOnlyScope;
  orgId: string;
  orgSlug: string | null;
  row: Pick<WorkbotTeamSettingsTeam, "agent">;
  canEdit: boolean;
}) {
  const policy = useWorkbotProactive(orgId, Boolean(orgId), scope);
  const savePolicy = useSaveWorkbotProactive(orgId, scope);
  const saveTeam = useSaveWorkbotTeamSettings(orgId);
  const [saveError, setSaveError] = useState<string | null>(null);
  // After "Use Everyone's": the team's settings as they were, for Undo. After that Undo: the way back is "Use Everyone's" again.
  const [saved, setSaved] = useState<{ now: "everyone"; previous: AgentPolicyView } | { now: "own" } | null>(null);
  const pending = saveTeam.isPending || savePolicy.isPending;
  const changed = workbotTeamAgentsChanged(row, policy.data);

  async function followEveryone() {
    const previous = policy.data;
    if (!previous) return;
    setSaveError(null);
    setSaved(null);
    try {
      await saveTeam.mutateAsync({ teamId: scope.teamId, change: { agent: { inherit: true } } });
      setSaved({ now: "everyone", previous });
    } catch (error) {
      setSaveError(errorMessage(error, "Couldn't save this team's Workbot settings. Try again."));
    }
  }

  async function restore(previous: AgentPolicyView) {
    setSaveError(null);
    try {
      // What the save starts from: Everyone's settings as they are now.
      const current = await policy.refetch();
      if (current.isError || !current.data) throw new Error("Couldn't load Everyone's settings. Try again.");
      await savePolicy.mutateAsync(agentPolicyRestoreChange(previous, current.data));
      setSaved({ now: "own" });
    } catch (error) {
      setSaveError(errorMessage(error, "Couldn't save this team's Workbot settings. Try again."));
    }
  }

  return (
    <div className={show === "all" ? "mt-3" : undefined} data-testid="team-workbot-agents">
      <WorkbotProactiveSection
        orgId={orgId}
        scope={scope}
        show={show}
        canManage={canEdit}
        connectorsHref={getMcpConnectionsRoute(orgSlug)}
        busy={pending}
        onEdit={() => {
          setSaveError(null);
          setSaved(null);
        }}
        headerAside={(
          <>
            <ScopeChip scope={scope} changed={changed} />
            {canEdit && changed ? (
              <UseEveryonesButton settingLabel={WORKBOT_AGENTS_LABEL} disabled={pending || !policy.data} onClick={() => void followEveryone()} />
            ) : null}
          </>
        )}
        belowHeader={saveError || saved ? (
          <>
            {saveError ? <p role="alert" className="px-1 text-[13px] text-red-700">{saveError}</p> : null}
            {saved ? (
              <SavedUndoLine
                message={workbotTeamAgentsSavedMessage(saved.now)}
                pending={pending}
                onUndo={() => void (saved.now === "everyone" ? restore(saved.previous) : followEveryone())}
              />
            ) : null}
          </>
        ) : null}
      />
    </div>
  );
}

/** A team: each row shows Everyone's value until the team changes it, and "Use Everyone's" takes it back. */
function TeamWorkbotSettings({ scope, orgId, orgSlug, view, models, canEdit, parts, help }: RowsProps & { scope: TeamOnlyScope }) {
  const ids = { enabled: useId(), model: useId(), maxSteps: useId(), name: useId() };
  const save = useSaveWorkbotTeamSettings(orgId);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ change: WorkbotTeamSettingsWrite; undo: WorkbotTeamSettingsWrite } | null>(null);
  // What is typed in the name field; null while it shows the saved name.
  const [nameDraft, setNameDraft] = useState<string | null>(null);

  const data = view.data;
  const settings = models.data;
  const row = data ? workbotTeamRow(data, scope) : null;
  // Null while the step limit isn't on: no row.
  const stepLimit = data && row ? workbotTeamStepLimit(data, row) : null;
  const disabled = !canEdit || save.isPending;
  const shownName = row && !row.name.inherit ? row.name.value : workbotDisplayName(data?.organization.name);
  const nameToSave = nameDraft === null ? null : workbotTeamNameToSave(nameDraft, shownName);
  const drafting = nameDraft !== null && nameDraft.trim() !== shownName;

  async function store(change: WorkbotTeamSettingsWrite, undo: WorkbotTeamSettingsWrite): Promise<boolean> {
    setSaveError(null);
    setSaved(null);
    try {
      await save.mutateAsync({ teamId: scope.teamId, change });
      setSaved({ change, undo });
      return true;
    } catch (error) {
      setSaveError(errorMessage(error, "Couldn't save this team's Workbot settings. Try again."));
      return false;
    }
  }

  async function saveName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!row || nameToSave === null) return;
    if (await store({ name: { inherit: false, value: nameToSave } }, { name: row.name })) setNameDraft(null);
  }

  return (
    <>
      {parts.general ? (<>
      <DenCard size="comfortable" className="divide-y divide-gray-100 overflow-hidden !p-0" data-section="team-workbot-settings">
        <SettingRow
          label="Workbot"
          labelId={ids.enabled}
          aside={help ? <HelpTip label="Workbot">{WORKBOT_SETTING_HELP.enabled}</HelpTip> : null}
          stateLine={data && row && !workbotTeamEnabled(data, row) ? <span data-testid="team-workbot-off">{workbotOffLine(scope)}</span> : null}
        >
          {view.isError ? <Unavailable /> : !data || !row ? <SwitchSkeleton /> : (
            <>
              <ScopeChip scope={scope} changed={!row.enabled.inherit} />
              {canEdit && !row.enabled.inherit ? (
                <UseEveryonesButton settingLabel="Workbot" disabled={save.isPending} onClick={() => void store({ enabled: { inherit: true } }, { enabled: row.enabled })} />
              ) : null}
              <WorkbotSwitch
                checked={workbotTeamEnabled(data, row)}
                disabled={disabled}
                onChange={(value) => void store({ enabled: { inherit: false, value } }, { enabled: row.enabled })}
              />
            </>
          )}
        </SettingRow>
        <SettingRow label="Default model" labelId={ids.model} aside={help ? <HelpTip label="Default model">{WORKBOT_SETTING_HELP.model}</HelpTip> : null}>
          {view.isError ? <Unavailable /> : !data || !row ? <FieldSkeleton className="w-80" /> : (
            <>
              <ScopeChip scope={scope} changed={!row.model.inherit} />
              {canEdit && !row.model.inherit ? (
                <UseEveryonesButton settingLabel="Default model" disabled={save.isPending} onClick={() => void store({ model: { inherit: true } }, { model: row.model })} />
              ) : null}
              {models.isError ? <Unavailable /> : !settings ? <FieldSkeleton className="w-80" /> : (
                <WorkbotModelPicker
                  saved={workbotTeamModel(data, row)}
                  settings={settings}
                  disabled={disabled}
                  onPick={(value) => void store({ model: { inherit: false, value } }, { model: row.model })}
                />
              )}
            </>
          )}
        </SettingRow>
        {stepLimit ? (
          <SettingRow label="Step limit" labelId={ids.maxSteps} aside={help ? <HelpTip label="Step limit">{STEP_LIMIT_HELP}</HelpTip> : null}>
            <ScopeChip scope={scope} changed={!stepLimit.setting.inherit} />
            {canEdit && !stepLimit.setting.inherit ? (
              <UseEveryonesButton settingLabel="Step limit" disabled={save.isPending} onClick={() => void store({ maxSteps: { inherit: true } }, { maxSteps: stepLimit.setting })} />
            ) : null}
            <WorkbotStepLimitSelect
              labelId={ids.maxSteps}
              saved={stepLimit.value}
              disabled={disabled}
              onPick={(value) => void store({ maxSteps: { inherit: false, value } }, { maxSteps: stepLimit.setting })}
            />
          </SettingRow>
        ) : null}
        <SettingRow label="Name" labelId={ids.name} aside={help ? <HelpTip label="Name">{WORKBOT_SETTING_HELP.name}</HelpTip> : null}>
          {view.isError ? <Unavailable /> : !data || !row ? <FieldSkeleton className="w-64" /> : (
            <>
              <ScopeChip scope={scope} changed={!row.name.inherit} />
              {/* While a name is being typed, the row's actions are Save and Discard. */}
              {canEdit && !row.name.inherit && !drafting ? (
                <UseEveryonesButton
                  settingLabel="Name"
                  disabled={save.isPending}
                  onClick={() => {
                    setNameDraft(null);
                    void store({ name: { inherit: true } }, { name: row.name });
                  }}
                />
              ) : null}
              <form className="flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2" aria-label="Workbot's name for this team" onSubmit={(event) => void saveName(event)}>
                <div className="w-64 min-w-0 max-w-full">
                  <DenInput
                    type="text"
                    aria-labelledby={ids.name}
                    value={nameDraft ?? shownName}
                    maxLength={WORKBOT_TEAM_NAME_MAX_LENGTH}
                    autoComplete="off"
                    disabled={disabled}
                    data-testid="team-workbot-name-input"
                    onChange={(event) => setNameDraft(event.target.value)}
                  />
                </div>
                {drafting ? (
                  <>
                    <DenButton variant="secondary" size="sm" disabled={save.isPending} onClick={() => setNameDraft(null)}>Discard</DenButton>
                    <DenButton type="submit" size="sm" loading={save.isPending} disabled={nameToSave === null}>Save name</DenButton>
                  </>
                ) : null}
              </form>
            </>
          )}
        </SettingRow>
        <ConflictLine count={row?.conflictingMemberCount ?? 0} setting={WORKBOT_CONFLICT_SETTING} testId="team-workbot-conflicts" />
      </DenCard>

      {saveError ? <p role="alert" className="px-1 text-[13px] text-red-700">{saveError}</p> : null}
      {saved ? (
        <SavedUndoLine message={workbotTeamSavedMessage(saved.change, settings)} pending={save.isPending} onUndo={() => void store(saved.undo, saved.change)} />
      ) : null}
      </>) : null}
      {parts.agents && data && row && workbotAgentsShown(data) ? (
        <TeamMembersAgents scope={scope} orgId={orgId} orgSlug={orgSlug} row={row} canEdit={canEdit} show={parts.agents} />
      ) : null}
    </>
  );
}
