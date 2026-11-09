"use client";

import type { ConfigApplyReport, ConfigChangeRequestSummary, ConfigDecisions, ConfigPlan, ConfigSecretInput } from "@openwork/types/den/config-blobs";
import { ArrowLeft, CheckCircle2, LockKeyhole, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useDenFlow } from "../../../_providers/den-flow-provider";
import { DenButton } from "../../../_components/ui/button";
import { DenChip } from "../../../_components/ui/chip";
import { DenNotice } from "../../../_components/ui/notice";
import { DenSkeleton } from "../../../_components/ui/skeleton";
import { UnderlineTabs } from "../../../_components/ui/tabs";
import { getConfigChangeRequestRoute, getConfigRoute } from "../../../_lib/den-org";
import { useOrgDashboard } from "../../_providers/org-dashboard-provider";
import { ItemMenu, type ItemMenuEntry } from "../item-list";
import {
  configBlobPaths,
  downloadConfigFile,
  useConfigChangeRequest,
  useConfigPlan,
  useConfigRequestAction,
  useSaveConfigDecisions,
  useSaveConfigInputs,
} from "./config-blobs-data";
import {
  CONFIG_OP_LABELS,
  type ConfigStep,
  configExportFileName,
  formatRelativeTime,
  isTransientStatus,
  planSteps,
} from "./config-blobs-model";
import { ConfigCounts, ConfigStatusChip, useConfigBlobsFeature } from "./config-blobs-parts";
import { changeRequestByline, changeRequestTitle } from "./config-change-list";
import {
  MatchStep,
  PeopleStep,
  ReferencesStep,
  ReviewStep,
  SecretsStep,
  destructiveEntries,
  destructiveKey,
} from "./config-plan-steps";

const PLAN_READY_STATUSES: readonly ConfigChangeRequestSummary["status"][] = ["needs_review", "approved", "queued", "applying", "applied", "failed", "stale", "superseded", "cancelled"];
const CANCELLABLE: readonly ConfigChangeRequestSummary["status"][] = ["uploaded", "analyzing", "needs_review", "approved", "stale"];

export function ConfigChangeRequestScreen({ changeRequestId }: { changeRequestId: string }) {
  const { ready } = useConfigBlobsFeature();
  const { orgId, activeOrg } = useOrgDashboard();
  const detail = useConfigChangeRequest(ready ? orgId : null, changeRequestId);
  const request = detail.data?.changeRequest ?? null;
  const planVersion = request && PLAN_READY_STATUSES.includes(request.status) ? `${request.status}:${request.planHash ?? ""}` : null;
  const planQuery = useConfigPlan(ready ? orgId : null, changeRequestId, planVersion);

  if (!ready) return null;

  return (
    <section className="mx-auto flex w-full min-w-0 max-w-[960px] flex-col gap-6 p-4 sm:p-6 md:p-8" data-testid="config-change-request-screen">
      <Link
        href={getConfigRoute(activeOrg?.slug, request && !isOpenStatus(request.status) ? "history" : "changes")}
        className="inline-flex w-fit items-center gap-1.5 rounded-md text-[13px] font-medium text-gray-500 hover:text-gray-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-400"
      >
        <ArrowLeft className="size-4" strokeWidth={1.5} aria-hidden="true" />
        Config
      </Link>
      {detail.isError ? (
        <DenNotice tone="error" message={detail.error.message} action={<DenButton variant="secondary" size="sm" onClick={() => void detail.refetch()}>Try again</DenButton>} />
      ) : !request ? (
        <HeaderSkeleton />
      ) : (
        <ChangeRequestBody
          request={request}
          report={detail.data?.report ?? null}
          plan={planQuery.data?.plan ?? null}
          decisions={planQuery.data?.decisions ?? null}
          planLoading={planVersion !== null && planQuery.isPending}
          planError={planQuery.isError ? planQuery.error.message : null}
        />
      )}
    </section>
  );
}

function isOpenStatus(status: ConfigChangeRequestSummary["status"]): boolean {
  return ["uploaded", "analyzing", "needs_review", "approved", "queued", "applying", "stale"].includes(status);
}

function HeaderSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-busy="true">
      <DenSkeleton className="h-6 w-72" />
      <DenSkeleton className="h-4 w-96" />
      <DenSkeleton className="mt-6 h-8 w-full" />
      <DenSkeleton className="h-24 w-full" />
    </div>
  );
}

function ChangeRequestBody({ request, report, plan, decisions, planLoading, planError }: {
  request: ConfigChangeRequestSummary;
  report: ConfigApplyReport | null;
  plan: ConfigPlan | null;
  decisions: ConfigDecisions | null;
  planLoading: boolean;
  planError: string | null;
}) {
  const router = useRouter();
  const { orgId, activeOrg } = useOrgDashboard();
  const { runtimeConfig, runtimeConfigLoaded } = useDenFlow();
  const action = useConfigRequestAction(orgId, request.id);
  const saveDecisions = useSaveConfigDecisions(orgId, request.id);
  const saveInputs = useSaveConfigInputs(orgId, request.id);
  const [step, setStep] = useState<ConfigStep | null>(null);
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const editable = request.status === "needs_review" || request.status === "approved";
  const saving = saveDecisions.isPending || saveInputs.isPending;
  const steps = useMemo(() => planSteps(plan, decisions), [plan, decisions]);
  const activeStep = step && steps.some((entry) => entry.step === step) ? step : (steps.find((entry) => entry.open > 0)?.step ?? "review");
  const destructive = useMemo(() => destructiveEntries(plan), [plan]);
  const unconfirmed = destructive.filter((entry) => !confirmed.has(destructiveKey(entry.area, entry.item))).length;
  const blocking = plan?.summary.blocking ?? request.summary?.blocking ?? 0;
  // Self-hosted servers run in single-organization mode; only they can read secrets from environment variables.
  const selfHosted = runtimeConfigLoaded && runtimeConfig.orgMode === "single_org";

  function updateDecisions(next: ConfigDecisions) {
    setError(null);
    saveDecisions.mutate(next, { onError: (cause) => setError(cause.message) });
  }

  async function updateInput(input: ConfigSecretInput) {
    setError(null);
    try {
      await saveInputs.mutateAsync({ inputs: [input] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't save this secret.");
    }
  }

  function run(kind: "approve" | "apply" | "revert") {
    setError(null);
    const planHash = plan?.planHash ?? request.planHash ?? undefined;
    action.mutate(
      { action: kind, ...(kind === "revert" ? {} : { planHash }) },
      {
        onError: (cause) => setError(cause.message),
        onSuccess: (result) => {
          if (kind === "revert") router.push(getConfigChangeRequestRoute(activeOrg?.slug, result.changeRequest.id));
        },
      },
    );
  }

  async function downloadSnapshot() {
    if (!orgId) return;
    setError(null);
    try {
      await downloadConfigFile(orgId, configBlobPaths.beforeSnapshot(request.id), configExportFileName(activeOrg?.slug, new Date(request.appliedAt ?? request.updatedAt), "before"), "Couldn't download what this change replaced.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't download what this change replaced.");
    }
  }

  const menu: ItemMenuEntry[] = [
    ...(request.appliedAt || request.status === "failed" ? [{ label: "Download what it replaced", onSelect: downloadSnapshot }] : []),
    ...(CANCELLABLE.includes(request.status) ? [{
      label: "Cancel change",
      destructive: true,
      onSelect: async () => { await action.mutateAsync({ action: "cancel" }); },
      confirm: { title: "Cancel this change?", description: "Nothing from this file is applied. Secrets entered for it are deleted.", action: "Cancel change" },
    }] : []),
  ];

  const approveBlockedReason = blocking > 0
    ? `${blocking} ${blocking === 1 ? "item needs" : "items need"} a decision`
    : unconfirmed > 0 ? `Confirm ${unconfirmed} ${unconfirmed === 1 ? "removal" : "removals"} in Review` : null;

  const primary = request.status === "needs_review" ? (
    <DenButton icon={CheckCircle2} disabled={approveBlockedReason !== null || !plan || saving} loading={action.isPending} onClick={() => run("approve")} data-testid="config-approve">
      {request.autoApply ? "Approve and apply" : "Approve"}
    </DenButton>
  ) : request.status === "approved" ? (
    <DenButton disabled={saving || unconfirmed > 0} loading={action.isPending} onClick={() => run("apply")} data-testid="config-apply">Apply now</DenButton>
  ) : request.status === "applied" && !request.revertedByChangeRequestId ? (
    <DenButton variant="secondary" icon={RotateCcw} loading={action.isPending} onClick={() => run("revert")} data-testid="config-revert">Revert</DenButton>
  ) : null;

  return (
    <>
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h1 className="min-w-0 truncate text-[20px] font-semibold tracking-[-0.3px] text-gray-950">{changeRequestTitle(request)}</h1>
            <ConfigStatusChip status={request.status} />
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {primary}
            <ItemMenu label="More actions" entries={menu} size="md" />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-gray-500">
          <span>{changeRequestByline(request)}</span>
          <ConfigCounts summary={plan?.summary ?? request.summary} />
        </div>
        {request.status === "needs_review" && approveBlockedReason ? (
          <p className="flex items-center gap-1.5 text-[13px] text-gray-600" data-testid="config-approve-blocked">
            <LockKeyhole className="size-3.5" strokeWidth={1.5} aria-hidden="true" />
            {approveBlockedReason}
          </p>
        ) : null}
        <RequestLinks request={request} />
        {request.approvals.length > 0 ? (
          <p className="text-[13px] text-gray-600" data-testid="config-approvals">
            Approved by {request.approvals.map((approval) => `${approval.name ?? "a member"} (${formatRelativeTime(approval.at)})`).join(", ")}
          </p>
        ) : null}
      </header>

      {error ? <DenNotice tone="error" message={error} /> : null}
      {request.errors.length > 0 ? (
        <DenNotice tone="error" message={request.errors.length === 1 ? request.errors[0] : <ul className="list-disc pl-4">{request.errors.map((entry) => <li key={entry}>{entry}</li>)}</ul>} />
      ) : null}
      {plan?.issues.map((issue) => (
        <DenNotice key={`${issue.level}:${issue.message}`} tone={issue.level === "error" ? "error" : issue.level === "warning" ? "warning" : "neutral"} message={issue.message} />
      ))}
      {planError ? <DenNotice tone="error" message={planError} /> : null}

      {report ? <ApplyReport report={report} /> : null}

      {planLoading || (isTransientStatus(request.status) && !plan) ? (
        <div className="flex flex-col gap-3" aria-busy="true" data-testid="config-plan-loading">
          <DenSkeleton className="h-8 w-80" />
          <DenSkeleton className="h-16 w-full" />
          <DenSkeleton className="h-16 w-full" />
        </div>
      ) : plan && decisions ? (
        <div className="flex flex-col gap-4">
          {steps.length > 1 ? (
            <UnderlineTabs
              tabs={steps.map((entry) => ({ value: entry.step, label: entry.label, count: entry.open > 0 ? entry.open : undefined, countTone: "warning" }))}
              activeTab={activeStep}
              onChange={setStep}
            />
          ) : null}
          {activeStep === "match" ? <MatchStep plan={plan} decisions={decisions} editable={editable} saving={saving} onDecisions={updateDecisions} /> : null}
          {activeStep === "references" ? <ReferencesStep plan={plan} decisions={decisions} editable={editable} saving={saving} onDecisions={updateDecisions} /> : null}
          {activeStep === "secrets" ? <SecretsStep plan={plan} editable={editable} saving={saving} selfHosted={selfHosted} onInput={updateInput} /> : null}
          {activeStep === "people" ? <PeopleStep plan={plan} decisions={decisions} editable={editable} saving={saving} onDecisions={updateDecisions} /> : null}
          {activeStep === "review" ? (
            <ReviewStep
              plan={plan}
              decisions={decisions}
              editable={editable}
              saving={saving}
              onDecisions={updateDecisions}
              confirmed={confirmed}
              onConfirm={(key, checked) => setConfirmed((current) => {
                const next = new Set(current);
                if (checked) next.add(key);
                else next.delete(key);
                return next;
              })}
            />
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function RequestLinks({ request }: { request: ConfigChangeRequestSummary }) {
  const { activeOrg } = useOrgDashboard();
  if (!request.revertsChangeRequestId && !request.revertedByChangeRequestId) return null;
  return (
    <p className="flex flex-wrap gap-x-4 text-[13px]">
      {request.revertsChangeRequestId ? (
        <Link className="text-gray-600 underline-offset-2 hover:text-gray-900 hover:underline" href={getConfigChangeRequestRoute(activeOrg?.slug, request.revertsChangeRequestId)}>Undoes an earlier change</Link>
      ) : null}
      {request.revertedByChangeRequestId ? (
        <Link className="text-gray-600 underline-offset-2 hover:text-gray-900 hover:underline" href={getConfigChangeRequestRoute(activeOrg?.slug, request.revertedByChangeRequestId)}>Reverted by a later change</Link>
      ) : null}
    </p>
  );
}

function ApplyReport({ report }: { report: ConfigApplyReport }) {
  const failed = report.items.filter((item) => item.status === "failed");
  const applied = report.items.filter((item) => item.status === "applied").length;
  const skipped = report.items.filter((item) => item.status === "skipped").length;
  const warnings = [...report.warnings, ...report.items.flatMap((item) => item.warnings.map((warning) => `${item.ref}: ${warning}`))];
  return (
    <section className="flex flex-col gap-2" aria-label="Apply report" data-testid="config-apply-report">
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <DenChip tone={failed.length > 0 ? "danger" : "success"}>{applied} applied</DenChip>
        {failed.length > 0 ? <DenChip tone="danger">{failed.length} failed</DenChip> : null}
        {skipped > 0 ? <DenChip tone="neutral">{skipped} skipped</DenChip> : null}
        {warnings.length > 0 ? <DenChip tone="warning">{warnings.length} {warnings.length === 1 ? "warning" : "warnings"}</DenChip> : null}
      </div>
      {failed.length > 0 ? (
        <ul className="flex flex-col divide-y divide-gray-100 border-y border-gray-100 text-[13px]">
          {failed.map((item) => (
            <li key={`${item.area}:${item.ref}`} className="flex flex-col py-2">
              <span className="font-medium text-gray-900">{CONFIG_OP_LABELS[item.op]} {item.ref}</span>
              {item.error ? <span className="text-red-700">{item.error}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {warnings.length > 0 ? (
        <details className="group">
          <summary className="cursor-pointer list-none text-[13px] text-gray-600 hover:text-gray-900">Warnings</summary>
          <ul className="mt-1 list-disc pl-5 text-[13px] text-gray-600">
            {warnings.map((warning) => <li key={warning}>{warning}</li>)}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
