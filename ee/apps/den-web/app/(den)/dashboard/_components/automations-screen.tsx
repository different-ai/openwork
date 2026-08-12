"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, CalendarClock, Cloud, Play, Plus } from "lucide-react";
import { DenButton } from "../../_components/ui/button";
import { SavedScriptArtifactResult } from "./saved-script-artifact-result";
import {
  useAutomation,
  useAutomationArtifactSnapshot,
  useAutomationRun,
  useAutomationRuns,
  useAutomations,
  useRunAutomationNow,
} from "./automation-data";
import { CloudAutomationForm } from "./cloud-automation-form";

function statusTone(status: string) {
  return status === "failed" || status === "needs_attention" ? "bg-red-50 text-red-600" : status === "succeeded" || status === "active" ? "bg-emerald-50 text-emerald-700" : "bg-gray-100 text-gray-600";
}

export function AutomationsScreen() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const automationId = searchParams.get("automation")?.trim() || null;
  const runId = searchParams.get("run")?.trim() || null;
  const listQuery = useAutomations();
  const detailQuery = useAutomation(automationId);
  const runsQuery = useAutomationRuns(automationId);
  const runQuery = useAutomationRun(runId);
  const latestSuccessfulRunQuery = useAutomationRun(detailQuery.data?.automation.latestSuccessfulRunId ?? null);
  const runNow = useRunAutomationNow();
  const [creating, setCreating] = useState(false);
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

  if (listQuery.isLoading) return <div className="mx-auto max-w-[980px] px-6 py-8 text-[13px] text-gray-400">Loading Automations…</div>;
  if (listQuery.error) return <div className="mx-auto max-w-[980px] px-6 py-8 text-[13px] text-red-600">{listQuery.error.message}</div>;

  if (!automationId) {
    const items = listQuery.data?.items.filter((item) => item.automation.state !== "archived") ?? [];
    return (
      <div className="mx-auto max-w-[980px] px-6 py-8 md:px-8">
        <div className="flex flex-wrap items-start justify-between gap-4"><div><h1 className="text-[20px] font-semibold tracking-[-0.02em] text-gray-950">Automations</h1><p className="mt-1 text-[13px] text-gray-400">Automations created here run headlessly in OpenWork Cloud. Desktop-created Automations stay on Desktop.</p></div><DenButton onClick={() => setCreating(true)}><Plus className="h-3.5 w-3.5" />New Automation</DenButton></div>
        {creating ? <CloudAutomationForm onClose={() => setCreating(false)} onCreated={(id) => setQuery(id)} /> : null}
        <div className="mt-6 grid gap-3 md:grid-cols-2">{items.length === 0 ? <div className="rounded-2xl border border-gray-100 bg-white p-8 text-center text-[13px] text-gray-400">No Automations yet. Create a Cloud Automation here, or create a Desktop Automation in the app.</div> : items.map((item) => <button key={item.automation.id} type="button" onClick={() => setQuery(item.automation.id)} className="rounded-2xl border border-gray-100 bg-white p-4 text-left transition hover:border-gray-200 hover:bg-gray-50"><div className="flex items-start justify-between gap-3"><div><h2 className="text-[14px] font-semibold text-gray-900">{item.automation.name}</h2><p className="mt-1 line-clamp-2 text-[12px] text-gray-400">{item.revision.action?.kind === "saved_script" ? `Exact Script version ${item.revision.action.script.configObjectVersionId.slice(0, 8)}` : item.revision.instructions}</p></div><span className={`rounded-full px-2 py-0.5 text-[10px] ${statusTone(item.automation.state)}`}>{item.automation.state.replace("_", " ")}</span></div><div className="mt-4 flex items-center justify-between text-[11px] text-gray-400"><span>{item.latestRun ? `Last run ${item.latestRun.status}` : "Not run yet"}</span><span className="flex items-center gap-1"><Cloud className="h-3 w-3" />{item.revision.executionTarget === "cloud" ? "OpenWork Cloud" : "Desktop"}</span></div></button>)}</div>
      </div>
    );
  }

  if (detailQuery.isLoading || !detailQuery.data) return <div className="mx-auto max-w-[980px] px-6 py-8 text-[13px] text-gray-400">Loading Automation…</div>;
  const detail = detailQuery.data;
  const runs = runsQuery.data ?? [];
  return (
    <div className="mx-auto max-w-[1080px] px-6 py-8 md:px-8">
      <div className="flex flex-wrap items-start justify-between gap-4"><div className="flex items-start gap-3"><button type="button" aria-label="Back to Automations" onClick={() => setQuery(null)} className="rounded-lg p-2 text-gray-400 hover:bg-gray-50 hover:text-gray-800"><ArrowLeft className="h-4 w-4" /></button><div><div className="flex flex-wrap items-center gap-2"><h1 className="text-[20px] font-semibold text-gray-950">{detail.automation.name}</h1><span className={`rounded-full px-2 py-0.5 text-[10px] ${statusTone(detail.automation.state)}`}>{detail.automation.state.replace("_", " ")}</span></div><p className="mt-1 text-[12px] text-gray-400">Revision {detail.revision.version} · {detail.revision.executionTarget === "cloud" ? "OpenWork Cloud" : "Desktop"}</p></div></div><DenButton loading={runNow.isPending} onClick={() => void runNow.mutateAsync(detail.automation.id)}><Play className="h-3.5 w-3.5" />Run now</DenButton></div>

      {detail.automation.needsAttentionReason ? <div className="mt-5 rounded-xl border border-amber-100 bg-amber-50 px-4 py-3 text-[13px] text-amber-700">{detail.automation.needsAttentionReason.message}</div> : null}
      <div className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,1.1fr)_minmax(20rem,0.9fr)]">
        <div className="space-y-5">
          <section className="rounded-2xl border border-gray-100 bg-white p-5"><h2 className="text-[14px] font-semibold text-gray-900">{action?.kind === "saved_script" ? "Saved Script" : "Instructions"}</h2>{action?.kind === "saved_script" ? <div className="mt-3 space-y-3 text-[12px]"><div><p className="text-gray-400">Exact Script version</p><p className="break-all font-mono text-gray-700">{action.script.configObjectVersionId}</p></div><div><p className="text-gray-400">Input</p><pre className="mt-1 overflow-auto whitespace-pre-wrap rounded-xl bg-gray-950 p-3 font-mono text-[11px] text-gray-100">{JSON.stringify(action.input ?? {}, null, 2)}</pre></div></div> : <p className="mt-3 whitespace-pre-wrap text-[13px] text-gray-700">{detail.revision.instructions}</p>}</section>
          {latestSnapshot.data ? <section className="rounded-2xl border border-gray-100 bg-white p-5"><h2 className="text-[14px] font-semibold text-gray-900">Latest validated result</h2><p className="mt-1 text-[12px] text-gray-400">The last successful Dynamic Artifact remains readable after later failures.</p><div className="mt-4"><SavedScriptArtifactResult snapshot={latestSnapshot.data} lastSuccessful /></div></section> : null}
          <section className="rounded-2xl border border-gray-100 bg-white p-5"><h2 className="flex items-center gap-2 text-[14px] font-semibold text-gray-900"><CalendarClock className="h-4 w-4" />Run history</h2><div className="mt-3 space-y-2">{runs.length === 0 ? <p className="text-[13px] text-gray-400">No runs yet.</p> : runs.map((run) => <button key={run.id} type="button" onClick={() => setQuery(detail.automation.id, run.id)} className="flex w-full items-center justify-between rounded-xl border border-gray-100 p-3 text-left hover:bg-gray-50"><span><span className={`rounded-full px-2 py-0.5 text-[10px] ${statusTone(run.status)}`}>{run.status}</span><span className="ml-2 text-[11px] text-gray-400">{run.trigger}</span><span className="mt-1 block text-[11px] text-gray-400">{new Date(run.startedAt ?? run.createdAt).toLocaleString()}</span></span><span className="flex items-center gap-1 text-[11px] text-gray-400"><Cloud className="h-3 w-3" />{run.executionTarget === "cloud" ? "OpenWork Cloud" : "Desktop"}</span></button>)}</div></section>
        </div>
        <section className="h-fit rounded-2xl border border-gray-100 bg-white p-5"><h2 className="text-[14px] font-semibold text-gray-900">Run receipt</h2>{!runId ? <p className="mt-8 text-center text-[13px] text-gray-400">Select a run to inspect its durable receipt.</p> : runQuery.isLoading ? <p className="mt-4 text-[13px] text-gray-400">Loading receipt…</p> : runQuery.data ? <div className="mt-4 space-y-4">{runQuery.data.run.error ? <div className="rounded-xl bg-red-50 p-3 text-[12px] text-red-600">{runQuery.data.run.error.message}</div> : null}{selectedSnapshot.data ? <SavedScriptArtifactResult snapshot={selectedSnapshot.data} lastSuccessful={selectedSnapshot.data.receiptId === latestSnapshot.data?.receiptId} /> : runQuery.data.run.validatedResult !== undefined ? <pre className="overflow-auto whitespace-pre-wrap rounded-xl bg-gray-950 p-3 font-mono text-[11px] text-gray-100">{JSON.stringify(runQuery.data.run.validatedResult, null, 2)}</pre> : runQuery.data.run.resultSummary ? <p className="whitespace-pre-wrap text-[13px] leading-6 text-gray-700">{runQuery.data.run.resultSummary}</p> : <p className="text-[13px] text-gray-400">This run has no result yet.</p>}</div> : <p className="mt-4 text-[13px] text-red-600">The run receipt could not be loaded.</p>}</section>
      </div>
    </div>
  );
}
