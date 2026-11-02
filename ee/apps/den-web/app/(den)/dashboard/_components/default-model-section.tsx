"use client";

import {
  DEFAULT_MODEL_SOURCE_LABELS,
  sameDefaultModel,
  type DefaultModelChoice,
  type DefaultModelOption,
  type DefaultModelOptions,
  type DefaultModelSettings,
} from "@openwork/types/den/default-model";
import { Lock } from "lucide-react";
import { useEffect, useId, useState, type ReactNode } from "react";
import { DenBrandMark } from "../../_components/ui/brand-mark";
import { DenButton } from "../../_components/ui/button";
import { DenCard } from "../../_components/ui/card";
import { DenChip } from "../../_components/ui/chip";
import { DenCombobox, type DenComboboxOption } from "../../_components/ui/combobox";
import { DenNotice } from "../../_components/ui/notice";
import { DenSkeleton } from "../../_components/ui/skeleton";
import { getAiGatewayRoute, permissionLockReason } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { providerIconSlug } from "./library-models";
import { useDefaultModelOptions, useDefaultModelSettings, useSaveDefaultModel } from "./default-model-data";
import { savedDefaultModelState } from "./default-model-presentation";

/** The combobox value for "no model of its own": no default (organization) or use the organization's (team). */
const INHERIT_VALUE = "";
const VALUE_SEPARATOR = "::";

function valueOf(choice: DefaultModelChoice | null): string {
  return choice ? `${choice.providerId}${VALUE_SEPARATOR}${choice.modelId}` : INHERIT_VALUE;
}

function choiceOf(value: string): DefaultModelChoice | null {
  const at = value.indexOf(VALUE_SEPARATOR);
  if (!value || at <= 0) return null;
  return { providerId: value.slice(0, at), modelId: value.slice(at + VALUE_SEPARATOR.length) };
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

function findOption(options: DefaultModelOptions | undefined, choice: DefaultModelChoice | null): DefaultModelOption | null {
  return choice ? options?.options.find((option) => sameDefaultModel(option, choice)) ?? null : null;
}

/** Keep a previously verified display name when a source cannot be read. */
function useSavedModelOption(orgId: string, options: DefaultModelOptions | undefined, choice: DefaultModelChoice | null) {
  const listed = findOption(options, choice);
  const [remembered, setRemembered] = useState<{ orgId: string; option: DefaultModelOption } | null>(null);
  useEffect(() => {
    if (listed) setRemembered({ orgId, option: listed });
  }, [orgId, listed]);
  return listed ?? (remembered?.orgId === orgId && sameDefaultModel(remembered.option, choice) ? remembered.option : null);
}

export function defaultModelName(options: DefaultModelOptions | undefined, choice: DefaultModelChoice | null): string | null {
  if (!choice) return null;
  const option = findOption(options, choice);
  return option ? `${option.modelName} (${option.providerName})` : "Saved model";
}

function ModelMark({ option }: { option: Pick<DefaultModelOption, "providerName" | "logoProviderId"> }) {
  return (
    <DenBrandMark
      name={option.providerName}
      simpleIconSlug={providerIconSlug(option.logoProviderId)}
      className="h-5 w-5 rounded-[5px] border-gray-200"
      imageClassName="h-3.5 w-3.5"
    />
  );
}

function comboboxOptions(input: {
  options: DefaultModelOptions;
  saved: DefaultModelChoice | null;
  savedState: ReturnType<typeof savedDefaultModelState>;
  inherit: { label: string; description?: string; icon?: ReactNode };
}): DenComboboxOption[] {
  const listed: DenComboboxOption[] = input.options.options.map((option) => ({
    value: valueOf(option),
    label: option.modelName,
    description: option.providerName,
    meta: option.source === "openwork" ? undefined : DEFAULT_MODEL_SOURCE_LABELS[option.source],
    keywords: [option.providerName, option.modelId, DEFAULT_MODEL_SOURCE_LABELS[option.source]],
    icon: <ModelMark option={option} />,
  }));
  // A failed/partial list never relabels a saved choice as removed.
  const missing = input.saved && !findOption(input.options, input.saved)
    ? [{ value: valueOf(input.saved), label: input.savedState.label,
      description: input.savedState.availability === "unknown" ? "Availability not verified" : "Not in the current model list" }]
    : [];
  return [{ value: INHERIT_VALUE, label: input.inherit.label, description: input.inherit.description, icon: input.inherit.icon }, ...missing, ...listed];
}

function SettingRow({ label, labelId, aside, children }: { label: string; labelId: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-12 flex-wrap items-center justify-between gap-3 px-6 py-3">
      <span className="flex min-w-0 items-center gap-2">
        <span id={labelId} className="text-[13px] font-medium text-gray-900">{label}</span>
        {aside}
      </span>
      <div className="flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2">{children}</div>
    </div>
  );
}

type PickerProps = {
  scope: { kind: "organization" } | { kind: "team"; teamId: string };
  label: string;
  canManage: boolean;
  settings: DefaultModelSettings | undefined;
  /** The scope's saved model: the organization default, or the team's override. */
  saved: DefaultModelChoice | null;
  inherit: { label: string; description?: string; icon?: ReactNode };
  aside?: ReactNode;
  /** One line of state under the row (counts, conflicts). */
  stateLine?: ReactNode;
  settingsError: unknown;
  onRetrySettings: () => void;
};

/**
 * One default model row: a searchable list of the organization's models, read
 * live, saved as soon as it is picked, with Undo. Shared by Org settings and
 * each team's Access tab.
 */
function DefaultModelPicker({ scope, label, canManage, settings, saved, inherit, aside, stateLine, settingsError, onRetrySettings }: PickerProps) {
  const { orgId: scopedOrgId, orgSlug } = useOrgDashboard();
  const orgId = scopedOrgId ?? "";
  const labelId = useId();
  const options = useDefaultModelOptions(orgId, true);
  const save = useSaveDefaultModel(orgId);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedChange, setSavedChange] = useState<{ previous: DefaultModelChoice | null; next: DefaultModelChoice | null } | null>(null);
  const teamId = scope.kind === "team" ? scope.teamId : null;

  async function store(next: DefaultModelChoice | null, previous: DefaultModelChoice | null) {
    setSaveError(null);
    setSavedChange(null);
    try {
      await save.mutateAsync({ teamId, model: next });
      setSavedChange({ previous, next });
    } catch (error) {
      setSaveError(errorMessage(error, "Couldn't save the default model. Try again."));
    }
  }

  const gatewayUnavailable = options.data?.unavailableSources.includes("gateway") ?? false;
  const otherUnavailable = options.data?.unavailableSources.filter((source) => source !== "gateway") ?? [];
  const noModels = options.data !== undefined && options.data.options.length === 0 && options.data.unavailableSources.length === 0;
  const lastKnown = useSavedModelOption(orgId, options.data, saved);
  const savedState = savedDefaultModelState({ choice: saved, options: options.data, failed: options.isError, lastKnown });
  const savedMissing = Boolean(saved && savedState.availability === "not-listed");
  const loading = !settings || options.isPending;
  const savedName = (choice: DefaultModelChoice | null) => sameDefaultModel(choice, saved) && lastKnown
    ? `${lastKnown.modelName} (${lastKnown.providerName})` : defaultModelName(options.data, choice);

  let control: ReactNode;
  if (settingsError) {
    control = <span className="text-[13px] text-gray-500">Unavailable</span>;
  } else if (loading) {
    control = <DenSkeleton className="h-10 w-80 max-w-full" data-testid="default-model-skeleton" />;
  } else if (options.isError && !saved) {
    control = <span className="text-[13px] text-gray-500">Unavailable</span>;
  } else if (noModels && !saved) {
    control = (
      <>
        <span className="text-[13px] text-gray-500" data-testid="default-model-empty">No models yet</span>
        {canManage ? <DenButton variant="secondary" size="sm" href={getAiGatewayRoute(orgSlug)}>Set up models</DenButton> : null}
      </>
    );
  } else {
    control = (
      <div className="w-80 min-w-0 max-w-full" data-testid="default-model-picker">
        <DenCombobox
          ariaLabel={label}
          value={valueOf(saved)}
          options={comboboxOptions({ options: options.data ?? { options: [], unavailableSources: [] }, saved, savedState, inherit })}
          disabled={!canManage || save.isPending || options.isError}
          placeholder={inherit.label}
          searchPlaceholder="Search models"
          emptyLabel="No models match"
          onChange={(value) => {
            const next = choiceOf(value);
            if (sameDefaultModel(next, saved)) return;
            void store(next, saved);
          }}
        />
      </div>
    );
  }

  return (
    <div className="grid gap-3">
      {settingsError ? (
        <DenNotice
          tone="error"
          message={errorMessage(settingsError, "Couldn't load the default model.")}
          action={<DenButton variant="secondary" size="sm" onClick={onRetrySettings}>Try again</DenButton>}
        />
      ) : null}
      {!settingsError && options.isError ? (
        <DenNotice
          tone="error"
          message={errorMessage(options.error, "Couldn't load your organization's models.")}
          action={<DenButton variant="secondary" size="sm" loading={options.isFetching} onClick={() => void options.refetch()}>Try again</DenButton>}
        />
      ) : null}
      {gatewayUnavailable || otherUnavailable.length > 0 ? (
        <DenNotice
          tone="warning"
          message={gatewayUnavailable && otherUnavailable.length === 0
            ? "Couldn't load AI Gateway models. Your other models are listed."
            : "Some of your organization's models couldn't be loaded. The rest are listed."}
          action={<DenButton variant="secondary" size="sm" loading={options.isFetching} onClick={() => void options.refetch()}>Try again</DenButton>}
        />
      ) : null}
      {savedMissing ? (
        <DenNotice
          tone="warning"
          message="This saved model is not in the current list. Members who can't use the resolved default keep their desktop default. Choose another model."
        />
      ) : null}

      <DenCard size="comfortable" className="overflow-hidden !p-0" data-section={scope.kind === "team" ? "team-default-model" : "org-default-model"}>
        <SettingRow label={label} labelId={labelId} aside={aside}>{control}</SettingRow>
        {stateLine ? <div className="border-t border-gray-100 px-6 py-3 text-[13px] text-gray-500">{stateLine}</div> : null}
      </DenCard>

      {saveError ? <p role="alert" className="px-1 text-[13px] text-red-700">{saveError}</p> : null}
      {savedChange ? (
        <div role="status" className="flex items-center justify-between gap-3 px-1 text-[13px] text-gray-600">
          <span className="min-w-0 [overflow-wrap:anywhere]">
            {savedChange.next
              ? `Saved ${scope.kind === "team" ? "team" : "organization"} default: ${savedName(savedChange.next)}.`
              : scope.kind === "team" ? "Saved. This team uses the organization default." : "Saved. No organization default."}
          </span>
          <DenButton variant="ghost" size="xs" loading={save.isPending} onClick={() => void store(savedChange.previous, savedChange.next)}>
            Undo
          </DenButton>
        </div>
      ) : null}
      {!canManage && settings ? (
        <p className="flex items-center gap-2 px-1 text-[13px] text-gray-500">
          <Lock size={16} strokeWidth={1.5} aria-hidden="true" className="shrink-0" />
          {`Read only. ${permissionLockReason("inference.manage")}`}
        </p>
      ) : null}
    </div>
  );
}

function teamCountLabel(count: number): string {
  return count === 1 ? "1 team uses its own model." : `${count} teams use their own model.`;
}

/** Org settings › Default model: the model new desktop chats start with, for everyone. */
export function OrgDefaultModelSection({ canManage, embedded = false }: { canManage: boolean; /** Inside a page section that has its own spacing (Everyone › Models). */ embedded?: boolean }) {
  const orgId = useOrgDashboard().orgId ?? "";
  const settings = useDefaultModelSettings(orgId, true);
  const overriding = settings.data?.teams.filter((team) => team.model !== null).length ?? 0;
  return (
    <section className={embedded ? "grid gap-3" : "mt-6 grid gap-3"} aria-label="Default model" data-testid="org-default-model-section">
      <DefaultModelPicker
        scope={{ kind: "organization" }}
        label="Default model"
        canManage={canManage && (settings.data?.canEdit ?? true)}
        settings={settings.data}
        saved={settings.data?.everyone ?? null}
        inherit={{ label: "No default", description: "Desktops keep their own default" }}
        stateLine={overriding > 0 ? teamCountLabel(overriding) : null}
        settingsError={settings.error}
        onRetrySettings={() => void settings.refetch()}
      />
    </section>
  );
}

function conflictLine(count: number): string {
  return count === 1
    ? "1 member has conflicting team defaults. Their teams resolve to the organization default."
    : `${count} members have conflicting team defaults. Their teams resolve to the organization default.`;
}

/** A team's Access tab › Default model: use the organization default or pick the team's own. */
export function TeamDefaultModelSection({ teamId, canManage, embedded = false }: { teamId: string; canManage: boolean; /** Under a section title of the page's own (the team's Models tab). */ embedded?: boolean }) {
  const orgId = useOrgDashboard().orgId ?? "";
  const settings = useDefaultModelSettings(orgId, true);
  const options = useDefaultModelOptions(orgId, true);
  const team = settings.data?.teams.find((entry) => entry.teamId === teamId);
  const orgDefault = settings.data?.everyone ?? null;
  const orgDefaultOption = useSavedModelOption(orgId, options.data, orgDefault);
  const overridden = Boolean(team?.model);
  return (
    <section className={embedded ? "grid gap-3" : "mb-8 grid gap-3"} aria-label={embedded ? "Default model" : undefined} aria-labelledby={embedded ? undefined : "team-default-model-heading"} data-testid="team-default-model-section">
      {embedded ? null : <h2 id="team-default-model-heading" className="text-lg font-semibold text-gray-950">Default model</h2>}
      <DefaultModelPicker
        scope={{ kind: "team", teamId }}
        label="Default model"
        canManage={canManage && (settings.data?.canEdit ?? true)}
        settings={settings.data}
        saved={team?.model ?? null}
        inherit={orgDefault ? {
          // Inheriting shows which model that is; the chip beside the label says it is inherited.
          label: orgDefaultOption?.modelName ?? "Saved organization default",
          description: orgDefaultOption ? `Organization default, ${orgDefaultOption.providerName}` : "Organization default",
          icon: orgDefaultOption ? <ModelMark option={orgDefaultOption} /> : undefined,
        } : { label: "Use organization default", description: "No organization default" }}
        aside={settings.data ? (
          overridden ? <DenChip tone="info">Overridden</DenChip> : <DenChip>From organization</DenChip>
        ) : null}
        stateLine={team && team.conflictingMemberCount > 0 ? conflictLine(team.conflictingMemberCount) : null}
        settingsError={settings.error}
        onRetrySettings={() => void settings.refetch()}
      />
    </section>
  );
}
