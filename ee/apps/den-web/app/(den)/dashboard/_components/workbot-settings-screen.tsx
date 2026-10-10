"use client";

import Link from "next/link";
import { Lock } from "lucide-react";
import { useEffect, useId, useState } from "react";
import type { WorkbotSettings } from "@openwork/types/den/workbot-settings";
import {
  getBrandAppearanceRoute,
  getOrgAccessFlags,
  parseOrganizationMetadata,
  permissionLockReason,
} from "../../_lib/den-org";
import { DenButton } from "../../_components/ui/button";
import { DashboardPageTemplate } from "../../_components/ui/dashboard-page-template";
import { DenNotice } from "../../_components/ui/notice";
import { DenSelect } from "../../_components/ui/select";
import { DenSkeleton } from "../../_components/ui/skeleton";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { useSaveWorkbotModel, useWorkbotSettings } from "./workbot-settings-data";

/** The name Workbot introduces itself with: the organization's brand name, unless it is unset or OpenWork. */
function workbotName(metadata: string | null): string {
  const brand = parseOrganizationMetadata(metadata)?.brandAppName;
  const trimmed = typeof brand === "string" ? brand.trim() : "";
  return trimmed && trimmed !== "OpenWork" ? trimmed.slice(0, 40) : "Workbot";
}

function modelName(settings: WorkbotSettings, id: string | null): string {
  if (!id) return defaultLabel(settings);
  return settings.models.find((entry) => entry.id === id)?.name ?? "Unavailable model";
}

function defaultModelName(settings: WorkbotSettings): string {
  if (!settings.defaultModel) return "the default model";
  return settings.models.find((entry) => entry.id === settings.defaultModel)?.name ?? "the default model";
}

function defaultLabel(settings: WorkbotSettings): string {
  return settings.defaultModel ? `Default (${defaultModelName(settings)})` : "Default";
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

function SettingsRow({ label, labelId, children }: { label: string; labelId?: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-12 flex-wrap items-center justify-between gap-3 px-6 py-3">
      <span id={labelId} className="text-[13px] font-medium text-gray-900">{label}</span>
      <div className="flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2">{children}</div>
    </div>
  );
}

export function WorkbotSettingsScreen() {
  const { orgContext, orgSlug } = useOrgDashboard();
  const orgId = orgContext?.organization.id ?? "";
  const access = getOrgAccessFlags(
    orgContext?.currentMember.role ?? "member",
    orgContext?.currentMember.isOwner ?? false,
    orgContext?.currentMember.permissions,
  );
  const canManage = access.canManageModelsSettings;
  const query = useWorkbotSettings(orgId, Boolean(orgId));
  const save = useSaveWorkbotModel(orgId);
  const labelId = useId();
  const [draft, setDraft] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ previous: string | null } | null>(null);

  const settings = query.data;
  useEffect(() => {
    setDraft(settings?.model ?? "");
  }, [settings?.model]);

  const name = workbotName(orgContext?.organization.metadata ?? null);
  const savedModel = settings?.model ?? null;
  const draftModel = draft || null;
  const changed = draftModel !== savedModel;
  const canChoose = canManage && settings?.runnerReachable === true && !save.isPending;

  async function store(model: string | null, previous: string | null) {
    setSaveError(null);
    setSaved(null);
    try {
      await save.mutateAsync(model);
      setSaved({ previous });
    } catch (error) {
      setSaveError(errorMessage(error, "Couldn't save the default model. Try again."));
    }
  }

  return (
    <div data-testid="workbot-settings-screen">
      <DashboardPageTemplate
        title="Workbot"
        description={null}
        colors={["#ECFDF5", "#064E3B", "#047857", "#A7F3D0"]}
      >
        <div className="grid gap-4">
          {settings && !settings.runnerReachable ? (
            <DenNotice
              tone="error"
              message="Couldn't reach Workbot's models, so the model can't be changed right now."
              action={(
                <DenButton variant="secondary" size="sm" loading={query.isFetching} onClick={() => void query.refetch()}>
                  Try again
                </DenButton>
              )}
            />
          ) : null}
          {settings && settings.runnerReachable && !settings.modelAvailable && settings.model ? (
            <DenNotice
              tone="warning"
              message={`The saved model is no longer available. New messages use ${defaultModelName(settings)} until you choose another model.`}
            />
          ) : null}

          {query.isError ? (
            <DenNotice
              tone="error"
              message={errorMessage(query.error, "Couldn't load Workbot settings.")}
              action={(
                <DenButton variant="secondary" size="sm" loading={query.isFetching} onClick={() => void query.refetch()}>
                  Try again
                </DenButton>
              )}
            />
          ) : (
            <div className="divide-y divide-gray-100 overflow-hidden rounded-2xl border border-gray-100 bg-white" data-section="workbot-default-model">
              <SettingsRow label="Default model" labelId={labelId}>
                {!settings ? (
                  <DenSkeleton className="h-10 w-72" data-testid="workbot-model-skeleton" />
                ) : (
                  <>
                    <div className="w-72 min-w-0 max-w-full">
                      <DenSelect
                        aria-labelledby={labelId}
                        value={draft}
                        disabled={!canChoose}
                        searchLabel={settings.models.length > 8 ? "Search models" : undefined}
                        onChange={(event) => {
                          setDraft(event.target.value);
                          setSaved(null);
                          setSaveError(null);
                        }}
                      >
                        <option value="">{defaultLabel(settings)}</option>
                        {settings.model && !settings.models.some((entry) => entry.id === settings.model) ? (
                          <option value={settings.model} disabled>
                            Unavailable model
                          </option>
                        ) : null}
                        {settings.models.map((entry) => (
                          <option key={entry.id} value={entry.id}>
                            {entry.name}
                          </option>
                        ))}
                      </DenSelect>
                    </div>
                    {canManage ? (
                      <DenButton
                        size="sm"
                        loading={save.isPending && !saved}
                        disabled={!canChoose || !changed}
                        onClick={() => void store(draftModel, savedModel)}
                      >
                        Save model
                      </DenButton>
                    ) : null}
                  </>
                )}
              </SettingsRow>
              <SettingsRow label="Name">
                <span className="text-[13px] text-gray-900" data-testid="workbot-name">{name}</span>
                <Link
                  href={getBrandAppearanceRoute(orgSlug)}
                  className="rounded text-[13px] text-gray-500 underline-offset-2 hover:text-gray-900 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900"
                >
                  Change in Brand appearance
                </Link>
              </SettingsRow>
            </div>
          )}

          {saveError ? (
            <p role="alert" className="px-1 text-[13px] text-red-700">{saveError}</p>
          ) : null}
          {saved && settings ? (
            <div role="status" className="flex items-center justify-between gap-3 px-1 text-[13px] text-gray-600">
              <span className="min-w-0 [overflow-wrap:anywhere]">Saved. New messages use {modelName(settings, settings.model)}.</span>
              <DenButton
                variant="ghost"
                size="xs"
                loading={save.isPending}
                onClick={() => void store(saved.previous, settings.model)}
              >
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
      </DashboardPageTemplate>
    </div>
  );
}
