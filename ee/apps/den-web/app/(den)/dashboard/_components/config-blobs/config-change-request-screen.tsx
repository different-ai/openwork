"use client";

import type { ConfigApplyReport, ConfigAreaKey, ConfigChangeRequestSummary, ConfigDecisions, ConfigPlan, ConfigSecretInput } from "@openwork/types/den/config-blobs";
import { ArrowLeft, CheckCircle2, LockKeyhole, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { DenButton } from "../../../_components/ui/button";
import { DenNotice } from "../../../_components/ui/notice";
import { DenSkeleton } from "../../../_components/ui/skeleton";
import { UnderlineTabs } from "../../../_components/ui/tabs";
import { getConfigChangeRequestRoute, getConfigRoute } from "../../../_lib/den-org";
import { useOrgDashboard } from "../../_providers/org-dashboard-provider";
import { ItemMenu, type ItemMenuEntry } from "../item-list";
import {
  configBlobPaths,
  useConfigDownload,
  useConfigAreas,
  useConfigBlobSettings,
  useConfigChangeRequest,
  useConfigPlan,
  useConfigRequestAction,
  useSaveConfigDecisions,
  useSaveConfigInputs,
} from "./config-blobs-data";
import { ConfigApplyRuns } from "./config-apply-runs";
import {
  RESTORE_ACTION_LABEL,
  approvalState,
  canRestoreRequest,
  changeRequestTitle,
  type ConfigStep,
  configExportFileName,
  formatRelativeTime,
  isTransientStatus,
  planSteps,
  requestIssues,
  runFailure,
  splitRestoreIssues,
} from "./config-blobs-model";
import { ConfigCounts, ConfigStatusChip, useConfigBlobsFeature } from "./config-blobs-parts";
import { changeRequestByline } from "./config-change-list";
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
          runs={detail.data?.runs ?? []}
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

function ChangeRequestBody({ request, runs, plan, decisions, planLoading, planError }: {
  request: ConfigChangeRequestSummary;
  runs: readonly ConfigApplyReport[];
  plan: ConfigPlan | null;
  decisions: ConfigDecisions | null;
  planLoading: boolean;
  planError: string | null;
}) {
  const router = useRouter();
  const { orgId, activeOrg, orgContext } = useOrgDashboard();
  const areas = useConfigAreas(orgId);
  const settings = useConfigBlobSettings(orgId);
  const action = useConfigRequestAction(orgId, request.id);
  const downloadConfig = useConfigDownload(orgId);
  const saveDecisions = useSaveConfigDecisions(orgId, request.id);
  const saveInputs = useSaveConfigInputs(orgId, request.id);
  // The chosen step belongs to the status it was chosen in: once a request moves on (applied, say), it opens on its default step again.
  const [chosenStep, setChosenStep] = useState<{ status: ConfigChangeRequestSummary["status"]; step: ConfigStep } | null>(null);
  const step = chosenStep?.status === request.status ? chosenStep.step : null;
  const setStep = (next: ConfigStep) => setChosenStep({ status: request.status, step: next });
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const editable = request.status === "needs_review" || request.status === "approved";
  const saving = saveDecisions.isPending || saveInputs.isPending;
  const steps = useMemo(() => planSteps(plan, decisions), [plan, decisions]);
  const activeStep = step && steps.some((entry) => entry.step === step)
    ? step
    : (editable ? steps.find((entry) => entry.open > 0)?.step : undefined) ?? "review";
  const destructive = useMemo(() => destructiveEntries(plan), [plan]);
  // Approving confirmed the removals; past review they show as ticked.
  const shownConfirmed = useMemo(
    () => request.status === "needs_review" ? confirmed : new Set(destructive.map((entry) => destructiveKey(entry.area, entry.item))),
    [request.status, confirmed, destructive],
  );
  const unconfirmed = destructive.filter((entry) => !shownConfirmed.has(destructiveKey(entry.area, entry.item))).length;
  const blocking = plan?.summary.blocking ?? request.summary?.blocking ?? 0;
  // Self-hosted servers with an operator allowlist can read secrets from environment variables.
  const allowEnvSecrets = areas.data?.allowEnvSecrets ?? false;

  function updateDecisions(next: ConfigDecisions) {
    // Stay on the step being worked on; don't jump ahead when its last decision is made.
    setStep(activeStep);
    setError(null);
    saveDecisions.mutate(next, { onError: (cause) => setError(cause.message) });
  }

  async function updateInput(input: ConfigSecretInput | ConfigSecretInput[]) {
    setStep(activeStep);
    setError(null);
    try {
      await saveInputs.mutateAsync({ inputs: Array.isArray(input) ? input : [input] });
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
      await downloadConfig(configBlobPaths.beforeSnapshot(request.id), configExportFileName(activeOrg?.slug, new Date(request.appliedAt ?? request.updatedAt), "before"), "Couldn't download what this change replaced.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't download what this change replaced.");
    }
  }

  const menu: ItemMenuEntry[] = [
    ...(request.appliedAt || request.status === "failed" ? [{ label: "Download what it replaced", onSelect: downloadSnapshot }] : []),
    ...(CANCELLABLE.includes(request.status) ? [{
      // "Withdraw", not "Cancel": the dialog's own dismiss button is already called Cancel.
      label: "Withdraw change",
      destructive: true,
      onSelect: async () => { await action.mutateAsync({ action: "cancel" }); },
      confirm: { title: "Withdraw this change?", description: "Nothing from this file is applied. Secrets entered for it are deleted.", action: "Withdraw" },
    }] : []),
  ];

  const approval = approvalState({
    approvals: request.approvals,
    createdByMemberId: request.createdBy.memberId,
    memberId: orgContext?.currentMember.id ?? null,
    requireSecondApprover: settings.data?.settings.requireSecondApprover ?? false,
  });
  const approveBlockedReason = blocking > 0
    ? `${blocking} ${blocking === 1 ? "item needs" : "items need"} a decision`
    : unconfirmed > 0 ? `Confirm ${unconfirmed} ${unconfirmed === 1 ? "removal" : "removals"} in Review`
    : approval.reason;

  const canRestore = canRestoreRequest(request, runs.length);
  const areaLabels = new Map<ConfigAreaKey, string>([
    ...(areas.data?.areas ?? []).map((entry): [ConfigAreaKey, string] => [entry.key, entry.label]),
    ...(plan?.areas ?? []).map((entry): [ConfigAreaKey, string] => [entry.area, entry.label]),
  ]);
  const areaLabel = (key: ConfigAreaKey) => areaLabels.get(key) ?? key;
  // The newest run's failure box already explains its failure; don't repeat it in a banner above.
  const latestFailure = runs[0] ? runFailure(runs[0], areaLabel) : null;
  const errors = latestFailure ? request.errors.filter((entry) => !entry.includes(latestFailure.message)) : request.errors;
  const { cantUndo, rest: otherIssues } = splitRestoreIssues(requestIssues(plan));

  const primary = request.status === "needs_review" && !approval.canApprove ? null : request.status === "needs_review" ? (
    <DenButton icon={CheckCircle2} disabled={approveBlockedReason !== null || !plan || saving} loading={action.isPending} onClick={() => run("approve")} data-testid="config-approve">
      {request.autoApply ? "Approve and apply" : "Approve"}
    </DenButton>
  ) : request.status === "approved" ? (
    <DenButton disabled={saving} loading={action.isPending} onClick={() => run("apply")} data-testid="config-apply">Apply now</DenButton>
  ) : canRestore ? (
    <DenButton variant="secondary" icon={RotateCcw} loading={action.isPending} onClick={() => run("revert")} data-testid="config-revert">{RESTORE_ACTION_LABEL}</DenButton>
  ) : null;

  return (
    <>
      <header className="flex flex-col gap-2">
        {/* Long titles wrap beside the actions, which stay top-right. */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 pt-1">
            <h1 className="min-w-0 break-words text-[20px] font-semibold leading-7 tracking-[-0.3px] text-gray-950">{changeRequestTitle(request)}</h1>
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
            Approved by {request.approvals.map((entry) => `${entry.name ?? "a member"} (${formatRelativeTime(entry.at)})`).join(", ")}
            {request.status === "needs_review" && request.approvals.length < approval.needed ? ` · ${request.approvals.length} of ${approval.needed} approvals` : null}
          </p>
        ) : null}
      </header>

      {error ? <DenNotice tone="error" message={error} /> : null}
      {errors.length > 0 ? (
        <DenNotice tone="error" message={errors.length === 1 ? errors[0] : <ul className="list-disc pl-4">{errors.map((entry) => <li key={entry}>{entry}</li>)}</ul>} />
      ) : null}
      {cantUndo.length > 0 ? (
        <DenNotice
          tone="warning"
          message={(
            <div data-testid="config-restore-cant-undo">
              <p className="font-medium">Restoring can't undo what the earlier change set off:</p>
              <ul className="list-disc pl-4">{cantUndo.map((entry) => <li key={entry}>{entry}</li>)}</ul>
            </div>
          )}
        />
      ) : null}
      {otherIssues.map((issue) => (
        <DenNotice key={`${issue.level}:${issue.message}`} tone={issue.level === "error" ? "error" : issue.level === "warning" ? "warning" : "neutral"} message={issue.message} />
      ))}
      {planError ? <DenNotice tone="error" message={planError} /> : null}

      <ConfigApplyRuns runs={runs} areaLabel={areaLabel} canRestore={canRestore} />

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
          {activeStep === "secrets" ? <SecretsStep plan={plan} editable={editable} saving={saving} allowEnv={allowEnvSecrets} onInput={updateInput} /> : null}
          {activeStep === "people" ? <PeopleStep plan={plan} decisions={decisions} editable={editable} saving={saving} onDecisions={updateDecisions} /> : null}
          {activeStep === "review" ? (
            <ReviewStep
              plan={plan}
              decisions={decisions}
              editable={editable}
              saving={saving}
              onDecisions={updateDecisions}
              confirmed={shownConfirmed}
              closed={!editable}
              restore={request.source === "revert"}
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
        <Link className="text-gray-600 underline-offset-2 hover:text-gray-900 hover:underline" href={getConfigChangeRequestRoute(activeOrg?.slug, request.revertsChangeRequestId)}>Restores the config from before an earlier change</Link>
      ) : null}
      {request.revertedByChangeRequestId ? (
        <Link className="text-gray-600 underline-offset-2 hover:text-gray-900 hover:underline" href={getConfigChangeRequestRoute(activeOrg?.slug, request.revertedByChangeRequestId)}>Restored by a later change</Link>
      ) : null}
    </p>
  );
}
