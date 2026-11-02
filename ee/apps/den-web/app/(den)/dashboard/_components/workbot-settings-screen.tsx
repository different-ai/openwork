"use client";

import Link from "next/link";
import { Lock } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { WORKBOT_DEFAULT_MODEL_NAME, type WorkbotModelTest, type WorkbotSettings } from "@openwork/types/den/workbot-settings";
import {
  getBrandAppearanceRoute,
  getMcpConnectionsRoute,
  getOrgAccessFlags,
  orgFeatureEnabled,
  parseOrganizationMetadata,
  permissionLockReason,
} from "../../_lib/den-org";
import { DenButton } from "../../_components/ui/button";
import { ServiceReadinessNotice } from "../../_components/service-readiness-notice";
import { DashboardPageTemplate } from "../../_components/ui/dashboard-page-template";
import { DenNotice } from "../../_components/ui/notice";
import { DenBrandMark } from "../../_components/ui/brand-mark";
import { DenCombobox, type DenComboboxOption } from "../../_components/ui/combobox";
import { DenSkeleton } from "../../_components/ui/skeleton";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { providerIconSlug } from "./library-models";
import { useSaveWorkbotModel, useTestWorkbotDefaultModel, useWorkbotSettings } from "./workbot-settings-data";
import { WorkbotProactiveSection } from "./workbot-proactive-section";
import { WorkbotProactiveHealthSection } from "./workbot-proactive-health";

/** The name Workbot introduces itself with: the organization's brand name, unless it is unset or OpenWork. */
function workbotName(metadata: string | null): string {
  const brand = parseOrganizationMetadata(metadata)?.brandAppName;
  const trimmed = typeof brand === "string" ? brand.trim() : "";
  return trimmed && trimmed !== "OpenWork" ? trimmed.slice(0, 40) : "Workbot";
}

/** Runner model ids read "provider/model"; the provider part picks the logo. */
function ModelMark({ id, provider: brand }: { id: string; provider?: string }) {
  const provider = brand ?? (id.includes("/") ? id.slice(0, id.indexOf("/")) : id);
  return (
    <DenBrandMark
      name={provider}
      simpleIconSlug={providerIconSlug(provider)}
      className="h-5 w-5 rounded-[5px] border-gray-200"
      imageClassName="h-3.5 w-3.5"
    />
  );
}

/**
 * The model Workbot answers with: the organization's saved choice, or the built-in default when none is saved.
 * There is one default model; the picker always shows this one, never a separate "Default" entry.
 */
function effectiveModel(settings: WorkbotSettings): string | null {
  return settings.model ?? settings.defaultModel;
}

function isListed(settings: WorkbotSettings, id: string | null): boolean {
  return Boolean(id) && settings.models.some((entry) => entry.id === id);
}

function modelName(settings: WorkbotSettings, id: string | null): string {
  if (!id) return "No model";
  const listed = settings.models.find((entry) => entry.id === id)?.name;
  if (listed) return listed;
  // The built-in default keeps its name even when it isn't offered to this person.
  return !settings.model && id === settings.defaultModel ? WORKBOT_DEFAULT_MODEL_NAME : "Unavailable model";
}

/** The models that can be chosen, plus the current model when it isn't one of them, so the picker never hides it. */
function modelOptions(settings: WorkbotSettings): DenComboboxOption[] {
  const current = effectiveModel(settings);
  const missing = current && !isListed(settings, current)
    ? [{ value: current, label: modelName(settings, current), description: settings.gatewayModels ? "Not available to you" : "No longer available" }]
    : [];
  return [
    ...missing,
    ...settings.models.map((entry) => ({ value: entry.id, label: entry.name, keywords: [entry.id], icon: <ModelMark id={entry.id} provider={entry.provider} /> })),
  ];
}

function availabilityLabel(settings: WorkbotSettings, id: string): string {
  if (!settings.runnerReachable) return "Couldn't check";
  return isListed(settings, id) ? "Available" : "Unavailable";
}

function modelTestLabel(result: WorkbotModelTest | null | undefined): string {
  if (!result) return "Not tested (short paid request)";
  if (result.status === "answered") return "Answered";
  const messages = {
    model_unavailable: "Model unavailable. Choose an available model.",
    runner_unavailable: "Couldn't reach the runner. Ask your deployment admin.",
    credentials_unavailable: "Model key missing. Ask your deployment admin.",
    authentication_failed: "Access refused. Check the runner's model key.",
    payment_required: "Payment required. Check the model account.",
    provider_unavailable: "Model didn't answer. Try again later.",
    timed_out: "Test timed out. Try again later.",
    invalid_response: "No usable answer. Check the model route.",
    busy: "Another test is running. Try again shortly.",
  };
  return messages[result.errorCode];
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
  const modelTest = useTestWorkbotDefaultModel(orgId);
  const resetTest = modelTest.reset;
  const labelId = useId();
  const [draft, setDraft] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ previous: string | null } | null>(null);

  const settings = query.data;
  const current = settings ? effectiveModel(settings) : null;
  useEffect(() => {
    setDraft(current ?? "");
  }, [current]);

  useEffect(() => {
    resetTest();
  }, [orgId, current, draft, resetTest]);

  const name = workbotName(orgContext?.organization.metadata ?? null);
  // Members' agents ride on Workbot: shown only with the rollout on and Workbot deployed here.
  const proactive = orgFeatureEnabled(orgContext, "workbotProactive") && orgContext?.capabilities.workbot === true;
  const savedModel = settings?.model ?? null;
  const changed = draft !== (current ?? "");
  const canChoose = canManage && settings?.runnerReachable === true && !save.isPending && !modelTest.isPending;

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
      >
        <div className="grid gap-4">
          <ServiceReadinessNotice capabilities={orgContext?.deploymentCapabilities} />
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
          {settings && settings.runnerReachable && current && !isListed(settings, current) ? (
            <DenNotice
              tone="warning"
              message={`Workbot can't use ${modelName(settings, current) === "Unavailable model" ? "the saved model" : modelName(settings, current)} right now, so new messages won't send. Choose an available model, or ask your model administrator to check your AI Gateway access. Existing conversations are kept.`}
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
                  <DenSkeleton className="h-10 w-80 max-w-full" data-testid="workbot-model-skeleton" />
                ) : (
                  <>
                    <div className="w-80 min-w-0 max-w-full" data-testid="workbot-model-picker">
                      <DenCombobox
                        ariaLabel="Default model"
                        value={draft}
                        options={modelOptions(settings)}
                        disabled={!canChoose}
                        placeholder="Choose a model"
                        searchPlaceholder="Search models"
                        emptyLabel="No models match"
                        onChange={(value) => {
                          setDraft(value);
                          setSaved(null);
                          setSaveError(null);
                        }}
                      />
                    </div>
                    {draft || !settings.runnerReachable ? (
                      <span role="status" className="text-[13px] text-gray-600" data-testid="workbot-default-readiness">
                        {availabilityLabel(settings, draft)}
                      </span>
                    ) : null}
                    <DenButton variant="secondary" size="sm" loading={query.isFetching && !save.isPending} disabled={save.isPending} onClick={() => void query.refetch()}>
                      Check availability
                    </DenButton>
                    {canManage ? (
                      <DenButton
                        size="sm"
                        loading={save.isPending && !saved}
                        disabled={!canChoose || !changed || !draft}
                        onClick={() => void store(draft, savedModel)}
                      >
                        Save model
                      </DenButton>
                    ) : null}
                  </>
                )}
              </SettingsRow>
              {settings ? (
                <SettingsRow label="Completion check">
                  <span role="status" className="text-[13px] text-gray-600" data-testid="workbot-model-test-result">
                    {modelTest.isPending ? "Testing a short paid request"
                      : modelTest.isError ? errorMessage(modelTest.error, "Couldn't test the model. Try again.")
                      : modelTestLabel(modelTest.data)}
                  </span>
                  <DenButton variant="secondary" size="sm" loading={modelTest.isPending}
                    disabled={!canManage || changed || save.isPending || modelTest.isPending}
                    title="Sends a short synthetic prompt and may use paid inference. No chats or connected apps are used."
                    onClick={() => modelTest.mutate()}>
                    Test model
                  </DenButton>
                </SettingsRow>
              ) : null}
              {modelTest.data && settings ? (
                <details className="px-6 py-3 text-[13px] text-gray-600">
                  <summary className="cursor-pointer font-medium">Test details</summary>
                  <dl className="mt-3 grid gap-2 [overflow-wrap:anywhere]">
                    <div><dt className="font-medium">Requested model</dt><dd className="font-mono">{modelTest.data.requestedModel}</dd></div>
                    <div><dt className="font-medium">Provider-reported model</dt><dd className="font-mono">{modelTest.data.reportedModel ?? "Not reported"}</dd></div>
                  </dl>
                </details>
              ) : null}
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
              <span className="min-w-0 [overflow-wrap:anywhere]">Saved. New messages use {modelName(settings, effectiveModel(settings))}.</span>
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
          {proactive && orgId ? (
            <WorkbotProactiveSection orgId={orgId} canManage={canManage} connectorsHref={getMcpConnectionsRoute(orgSlug)} />
          ) : null}
          {proactive && orgId ? (
            <WorkbotProactiveHealthSection orgId={orgId} />
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
