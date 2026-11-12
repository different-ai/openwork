"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, CalendarClock, Cloud, ExternalLink, Monitor, Square } from "lucide-react";
import { formatAutomationSchedule } from "@openwork/types/automation-schedule";
import type { AutomationList } from "@openwork/types/automations";
import { DenButton } from "../../_components/ui/button";
import { DenSkeleton } from "../../_components/ui/skeleton";
import { DenPageHeader } from "../../_components/ui/page-header";
import { AUTOMATION_CARD_CLASS, CARD_TITLE_CLASS, DASHBOARD_PAGE_CLASS, SECTION_TITLE_CLASS } from "../../_components/ui/dashboard-styles";
import { useDenFlow } from "../../_providers/den-flow-provider";
import { FeatureIntroGate } from "../_features/feature-intros";
import { StatusDot } from "../_features/computers/computer-parts";
import { WorkflowArtifactResult } from "./workflow-artifact-result";
import {
  useAutomation,
  useAutomationArtifactSnapshot,
  useAutomationRun,
  useAutomationRuns,
  useAutomations,
  useCancelAutomationRun,
} from "./automation-data";

type AutomationListItem = AutomationList["items"][number];

const ACTIVE_RUN_STATUSES = new Set(["queued", "claimed", "running"]);

/** The Computers status language: a dot and a sentence-case word; color only for what needs attention. */
function AutomationStatus({ status }: { status: string }) {
  const tone = status === "failed" || status === "needs_attention" ? "danger" : status === "succeeded" || status === "active" ? "success" : "neutral";
  const label = status.replaceAll("_", " ");
  return <span className="inline-flex shrink-0 items-center gap-2 text-[12px] text-[var(--dls-text-secondary)]" data-status={status}>
    <StatusDot tone={tone} />{label.charAt(0).toUpperCase() + label.slice(1)}
  </span>;
}

function placementLabel(executionTarget: "desktop" | "cloud" | undefined) {
  return executionTarget === "cloud" ? "OpenWork Cloud" : "Desktop";
}

function PlacementIcon({ executionTarget }: { executionTarget: "desktop" | "cloud" | undefined }) {
  return executionTarget === "cloud" ? <Cloud className="h-3 w-3" /> : <Monitor className="h-3 w-3" />;
}

/** The surface that owns an Automation's lifecycle: Web for Cloud placement, Desktop for Desktop placement. */
function ManageLink({ item, openworkWebUrl }: { item: { automation: { id: string }; revision: { executionTarget?: "desktop" | "cloud" } }; openworkWebUrl: string }) {
  if (item.revision.executionTarget === "cloud") {
    const href = `${openworkWebUrl.replace(/\/$/, "")}/automations?automation=${encodeURIComponent(item.automation.id)}`;
    return <DenButton variant="secondary" size="sm" href={href} target="_blank" rel="noopener noreferrer" icon={ExternalLink}>Manage in OpenWork Web</DenButton>;
  }
  return <span className="inline-flex items-center gap-1.5 text-[12px] text-[var(--dls-text-secondary)]"><Monitor className="h-3.5 w-3.5" />Manage in OpenWork Desktop</span>;
}

/** Groups the monitor list by what needs eyes first: running, needs attention, scheduled, paused. */
function groupItems(items: AutomationListItem[]) {
  const running: AutomationListItem[] = [];
  const attention: AutomationListItem[] = [];
  const scheduled: AutomationListItem[] = [];
  const paused: AutomationListItem[] = [];
  for (const item of items) {
    if (item.latestRun && ACTIVE_RUN_STATUSES.has(item.latestRun.status)) running.push(item);
    else if (item.automation.state === "needs_attention") attention.push(item);
    else if (item.automation.state === "active") scheduled.push(item);
    else paused.push(item);
  }
  return [
    { title: "Running now", items: running },
    { title: "Needs attention", items: attention },
    { title: "Scheduled", items: scheduled },
    { title: "Paused", items: paused },
  ].filter((group) => group.items.length > 0);
}

export function AutomationsScreen() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { runtimeConfig } = useDenFlow();
  const automationId = searchParams.get("automation")?.trim() || null;
  const runId = searchParams.get("run")?.trim() || null;
  const listQuery = useAutomations();
  const detailQuery = useAutomation(automationId);
  const runsQuery = useAutomationRuns(automationId);
  const runQuery = useAutomationRun(runId);
  const latestSuccessfulRunQuery = useAutomationRun(detailQuery.data?.automation.latestSuccessfulRunId ?? null);
  const cancelRun = useCancelAutomationRun();
  const action = detailQuery.data?.revision.action;
  const configObjectId = action?.kind === "saved_script" ? action.script.configObjectId : null;
  const selectedSnapshot = useAutomationArtifactSnapshot(configObjectId, runQuery.data?.run.codemodeReceiptId ?? null);
  const latestSnapshot = useAutomationArtifactSnapshot(configObjectId, latestSuccessfulRunQuery.data?.run.codemodeReceiptId ?? null);

  const setQuery = (automation: string | null, run: string | null = null) => {
    const next = new URLSearchParams();
    if (automation) next.set("automation", automation);
    if (run) next.set("run", run);
    router.push(`${window.location.pathname}${next.size ? `?${next}` : ""}`);
  };

  if (listQuery.isLoading) return <div className={DASHBOARD_PAGE_CLASS} aria-busy="true" aria-label="Automations"><DenSkeleton className="mb-6 h-6 w-36" /><div className="grid gap-3 md:grid-cols-2">{[0, 1, 2, 3].map((id) => <DenSkeleton key={id} className="h-36 rounded-2xl" />)}</div></div>;
  if (listQuery.error) return <div className={`${DASHBOARD_PAGE_CLASS} text-[13px] text-[var(--ow-danger)]`}>{listQuery.error.message}</div>;

  if (!automationId) {
    const items = listQuery.data?.items.filter((item) => item.automation.state !== "archived") ?? [];
    const groups = groupItems(items);
    // With feature intros on, the My Automations intro replaces the list while there are none (DESIGN.md I1, I2);
    // with the flag off, the page and its empty line render as before.
    return (
      <FeatureIntroGate introKey="automations" facts={listQuery.data ? { automations: items.length } : null}>
        <div className={DASHBOARD_PAGE_CLASS} data-automations-monitor>
          <DenPageHeader size="compact" title="My Automations" state={`${items.length} Automations`} />
          {items.length === 0 ? (
            <div className="mt-6 rounded-2xl border border-gray-100 bg-white p-8 text-center text-[13px] text-[var(--dls-text-secondary)]">No Automations yet. Create one in OpenWork Web or in the desktop app; it will show up here once Den is scheduling it.</div>
          ) : groups.map((group) => (
            <section key={group.title} className="mt-6">
              <h2 className={SECTION_TITLE_CLASS}>{group.title}</h2>
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                {group.items.map((item) => (
                  <button key={item.automation.id} type="button" onClick={() => setQuery(item.automation.id)} className={`${AUTOMATION_CARD_CLASS} p-4 text-left transition-colors hover:border-[var(--dls-border)] hover:bg-[var(--dls-hover)]`}>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <h3 className={CARD_TITLE_CLASS}>{item.automation.name}</h3>
                        <p className="mt-1 line-clamp-2 text-[12px] text-[var(--dls-text-secondary)]">{item.revision.action?.kind === "saved_script" ? `Exact Workflow version ${item.revision.action.script.configObjectVersionId.slice(0, 8)}` : item.revision.instructions}</p>
                      </div>
                      <AutomationStatus status={item.automation.state} />
                    </div>
                    <p className="mt-3 text-[11px] text-[var(--dls-text-secondary)]">{formatAutomationSchedule(item.revision.schedule)}</p>
                    <div className="mt-2 flex items-center justify-between text-[11px] text-[var(--dls-text-secondary)]">
                      <span>{item.latestRun ? `Last run ${item.latestRun.status}` : item.automation.nextDueAt ? `Next ${new Date(item.automation.nextDueAt).toLocaleString()}` : "Not run yet"}</span>
                      <span className="flex items-center gap-1"><PlacementIcon executionTarget={item.revision.executionTarget} />{placementLabel(item.revision.executionTarget)}</span>
                    </div>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      </FeatureIntroGate>
    );
  }

  if (detailQuery.isLoading || !detailQuery.data) return <div className={DASHBOARD_PAGE_CLASS} aria-busy="true" aria-label="Automation"><DenSkeleton className="mb-6 h-6 w-40" /><DenSkeleton className="h-56 w-full" /></div>;
  const detail = detailQuery.data;
  const runs = runsQuery.data ?? [];
  const activeRun = runQuery.data?.run && ACTIVE_RUN_STATUSES.has(runQuery.data.run.status) ? runQuery.data.run : null;
  return (
    <div className={DASHBOARD_PAGE_CLASS} data-automations-monitor>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <button type="button" aria-label="Back to Automations" onClick={() => setQuery(null)} className="rounded-lg p-2 text-[var(--dls-text-secondary)] hover:bg-gray-50 hover:text-gray-800"><ArrowLeft className="h-4 w-4" /></button>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-[20px] font-semibold text-[var(--dls-text-primary)]">{detail.automation.name}</h1>
              <AutomationStatus status={detail.automation.state} />
            </div>
            <p className="mt-1 text-[12px] text-[var(--dls-text-secondary)]">Revision {detail.revision.version} · {placementLabel(detail.revision.executionTarget)} · {formatAutomationSchedule(detail.revision.schedule)}</p>
          </div>
        </div>
        <ManageLink item={detail} openworkWebUrl={runtimeConfig.openworkWebUrl} />
      </div>

      {detail.automation.needsAttentionReason ? <div className="mt-5 rounded-xl border border-[var(--dls-border)] bg-[var(--dls-hover)] px-4 py-3 text-[13px] text-[var(--dls-text-primary)]">{detail.automation.needsAttentionReason.message}</div> : null}
      <div className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,1.1fr)_minmax(20rem,0.9fr)]">
        <div className="space-y-5">
          <section className={`${AUTOMATION_CARD_CLASS} p-5`}>
            <h2 className={CARD_TITLE_CLASS}>{action?.kind === "saved_script" ? "Workflow" : "Instructions"}</h2>
            {action?.kind === "saved_script" ? (
              <div className="mt-3 space-y-3 text-[12px]">
                <div><p className="text-[var(--dls-text-secondary)]">Exact Workflow version</p><p className="break-all font-mono text-[var(--dls-text-primary)]">{action.script.configObjectVersionId}</p></div>
                <div><p className="text-[var(--dls-text-secondary)]">Input</p><pre className="mt-1 overflow-auto whitespace-pre-wrap rounded-xl bg-gray-950 p-3 font-mono text-[11px] text-gray-100">{JSON.stringify(action.input ?? {}, null, 2)}</pre></div>
              </div>
            ) : <p className="mt-3 whitespace-pre-wrap text-[13px] text-[var(--dls-text-primary)]">{detail.revision.instructions}</p>}
          </section>
          {latestSnapshot.data ? (
            <section className={`${AUTOMATION_CARD_CLASS} p-5`}>
              <h2 className={CARD_TITLE_CLASS}>Latest validated result</h2>
              <p className="mt-1 text-[12px] text-[var(--dls-text-secondary)]">The Workflow's last successful Artifact remains readable after later failures.</p>
              <div className="mt-4"><WorkflowArtifactResult snapshot={latestSnapshot.data} lastSuccessful /></div>
            </section>
          ) : null}
          <section className={`${AUTOMATION_CARD_CLASS} p-5`}>
            <h2 className={`flex items-center gap-2 ${CARD_TITLE_CLASS}`}><CalendarClock className="h-4 w-4" />Run history</h2>
            <div className="mt-3 border-t border-[var(--den-list-line)]">
              {runs.length === 0 ? <p className="text-[13px] text-[var(--dls-text-secondary)]">No runs yet.</p> : runs.map((run) => (
                <button key={run.id} type="button" onClick={() => setQuery(detail.automation.id, run.id)} className="flex min-h-12 w-full items-center justify-between border-b border-[var(--den-list-line)] py-1.5 text-left hover:bg-[var(--dls-hover)]">
                  <span>
                    <AutomationStatus status={run.status} />
                    <span className="ml-2 text-[11px] text-[var(--dls-text-secondary)]">{run.trigger}</span>
                    <span className="mt-1 block text-[11px] text-[var(--dls-text-secondary)]">{new Date(run.startedAt ?? run.createdAt).toLocaleString()}</span>
                  </span>
                  <span className="flex items-center gap-1 text-[11px] text-[var(--dls-text-secondary)]"><PlacementIcon executionTarget={run.executionTarget} />{placementLabel(run.executionTarget)}</span>
                </button>
              ))}
            </div>
          </section>
        </div>
        <section className={`${AUTOMATION_CARD_CLASS} h-fit p-5`}>
          <div className="flex items-center justify-between gap-3">
            <h2 className={CARD_TITLE_CLASS}>Run receipt</h2>
            {activeRun ? <DenButton variant="destructive" size="sm" loading={cancelRun.isPending} onClick={() => void cancelRun.mutateAsync(activeRun.id)}><Square className="h-3 w-3" />Cancel run</DenButton> : null}
          </div>
          {!runId ? <p className="mt-8 text-center text-[13px] text-[var(--dls-text-secondary)]">Select a run to inspect its durable receipt.</p> : runQuery.isLoading ? <p className="mt-4 text-[13px] text-[var(--dls-text-secondary)]">Loading receipt…</p> : runQuery.data ? (
            <div className="mt-4 space-y-4">
              {cancelRun.error ? <div className="rounded-xl bg-red-50 p-3 text-[12px] text-red-600">{cancelRun.error.message}</div> : null}
              {runQuery.data.run.executionThread?.nativeThreadId ? (
                <div className="rounded-xl bg-gray-50 p-3 text-[11px] text-gray-500">
                  <p className="font-medium text-[var(--dls-text-primary)]">Native OpenWork Cloud thread</p>
                  <p className="mt-1 break-all font-mono">{runQuery.data.run.executionThread.nativeThreadId}</p>
                  {runQuery.data.run.executionThread.workspaceId ? <p className="mt-1 break-all font-mono">Workspace {runQuery.data.run.executionThread.workspaceId}</p> : null}
                </div>
              ) : null}
              {runQuery.data.run.error ? <div className="rounded-xl bg-red-50 p-3 text-[12px] text-red-600">{runQuery.data.run.error.message}</div> : null}
              {selectedSnapshot.data
                ? <WorkflowArtifactResult snapshot={selectedSnapshot.data} lastSuccessful={selectedSnapshot.data.receiptId === latestSnapshot.data?.receiptId} />
                : runQuery.data.run.validatedResult !== undefined
                  ? <pre className="overflow-auto whitespace-pre-wrap rounded-xl bg-gray-950 p-3 font-mono text-[11px] text-gray-100">{JSON.stringify(runQuery.data.run.validatedResult, null, 2)}</pre>
                  : runQuery.data.run.resultSummary
                    ? <p className="whitespace-pre-wrap text-[13px] leading-6 text-[var(--dls-text-primary)]">{runQuery.data.run.resultSummary}</p>
                    : <p className="text-[13px] text-[var(--dls-text-secondary)]">This run has no result yet.</p>}
              <p className="text-[11px] text-[var(--dls-text-secondary)]">Usage: {runQuery.data.run.usage.inputTokens ?? "—"} input · {runQuery.data.run.usage.outputTokens ?? "—"} output · {runQuery.data.run.usage.costMicros === null ? "cost unavailable" : `$${(runQuery.data.run.usage.costMicros / 1_000_000).toFixed(4)}`}</p>
              {runQuery.data.events.length ? (
                <ol className="space-y-2 border-l border-gray-200 pl-3">
                  {runQuery.data.events.map((event) => (
                    <li key={event.id} className="text-[11px]">
                      <div className="flex justify-between gap-2"><span className="font-medium text-[var(--dls-text-primary)]">{event.type.replaceAll("_", " ")}</span><time className="text-[var(--dls-text-secondary)]">{new Date(event.createdAt).toLocaleTimeString()}</time></div>
                      <pre className="mt-1 overflow-auto whitespace-pre-wrap text-gray-500">{JSON.stringify(event.payload, null, 2)}</pre>
                    </li>
                  ))}
                </ol>
              ) : null}
            </div>
          ) : <p className="mt-4 text-[13px] text-red-600">The run receipt could not be loaded.</p>}
        </section>
      </div>
    </div>
  );
}
