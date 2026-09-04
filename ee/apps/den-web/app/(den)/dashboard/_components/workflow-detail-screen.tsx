"use client";

import { useRouter } from "next/navigation";
import { ArrowLeft, CalendarClock, History, Layers3, Share2 } from "lucide-react";
import { DenButton } from "../../_components/ui/button";
import { useDenFlow } from "../../_providers/den-flow-provider";
import { DenChip } from "../../_components/ui/chip";
import { useActivateArtifactView, useRetireArtifactView, useWorkflowLibraryDetail } from "./workflow-detail-data";
import { WorkflowDetailPanel } from "./workflow-detail-panel";

function shortDigest(value: string | null) {
  return value ? `${value.slice(0, 15)}…${value.slice(-8)}` : "—";
}

function cspSummary(csp: {
  connectDomains: string[];
  resourceDomains: string[];
  frameDomains: string[];
  baseUriDomains: string[];
}) {
  const domains = [...csp.connectDomains, ...csp.resourceDomains, ...csp.frameDomains, ...csp.baseUriDomains];
  return domains.length === 0 ? "CSP: no external origins" : `CSP: ${domains.join(", ")}`;
}

function freshnessLabel(state: "never_run" | "fresh" | "stale" | "needs_attention"): string {
  if (state === "fresh") return "Up to date";
  if (state === "stale") return "Last run was a while ago";
  if (state === "needs_attention") return "Needs attention";
  return "Not run yet";
}

function updatedDate(value: string): string {
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function WorkflowDetailScreen({ workflowId }: { workflowId: string }) {
  const router = useRouter();
  const { runtimeConfig } = useDenFlow();
  const detailQuery = useWorkflowLibraryDetail(workflowId);
  const activate = useActivateArtifactView(workflowId);
  const retire = useRetireArtifactView(workflowId);
  const detail = detailQuery.data;
  if (detailQuery.isLoading || !detail) {
    return <div className="mx-auto max-w-[1180px] px-6 py-10 text-[13px] text-gray-400">{detailQuery.error?.message ?? "Loading workflow…"}</div>;
  }
  const manager = detail.workflow.role === "manager";
  const canEdit = detail.workflow.role === "manager" || detail.workflow.role === "editor";
  const actionError = activate.error ?? retire.error;
  const display = detail.workflow.viewState === "build_failed"
    ? "Custom display failed"
    : detail.workflow.viewState === "custom_active"
      ? detail.workflow.activeViewTitle ?? "Custom display"
      : "Standard table";
  const overview = [
    { label: "Your role", value: canEdit ? "Can edit" : "Can run", description: null },
    { label: "Version", value: `Current · updated ${updatedDate(detail.script.currentVersion.createdAt)}`, description: null },
    { label: "Display", value: display, description: null },
    {
      label: "Schedules",
      value: String(detail.workflow.automationCount),
      description: detail.workflow.automationCount === 0 ? "None yet — click Automate to schedule it." : `${detail.workflow.automationCount} active schedule${detail.workflow.automationCount === 1 ? "" : "s"}.`,
    },
  ];

  return (
    <div className="mx-auto max-w-[1180px] space-y-6 px-6 py-8 md:px-8" data-testid="den-workflow-detail">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <button type="button" aria-label="Back to Library" onClick={() => router.push("/dashboard/library")} className="rounded-lg p-2 text-gray-400 hover:bg-gray-50 hover:text-gray-800"><ArrowLeft className="h-4 w-4" /></button>
          <div>
            <div className="flex flex-wrap items-center gap-2"><h1 className="text-[22px] font-semibold tracking-[-0.02em] text-gray-950">{detail.workflow.name}</h1><DenChip tone="teal">Workflow</DenChip><DenChip tone={detail.workflow.resultState === "fresh" ? "success" : detail.workflow.resultState === "needs_attention" ? "danger" : "warning"}>{freshnessLabel(detail.workflow.resultState)}</DenChip></div>
            <p className="mt-1 max-w-3xl text-[13px] text-gray-500">{detail.workflow.description || "A saved, repeatable workflow you can run, schedule, and share."}</p>
            {detail.workflow.plugin ? <p className="mt-1 text-[12px] text-gray-400">Shared through <strong>{detail.workflow.plugin.name}</strong>.</p> : null}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {manager ? <DenButton variant="secondary" href={`${runtimeConfig.openworkWebUrl.replace(/\/$/, "")}/automations?create=1&workflow=${encodeURIComponent(workflowId)}&version=${encodeURIComponent(detail.script.currentVersion.id)}`} target="_blank" rel="noopener noreferrer"><CalendarClock className="h-3.5 w-3.5" />Automate</DenButton> : null}
          {manager && detail.workflow.plugin ? <DenButton variant="secondary" href={`/dashboard/plugins/${encodeURIComponent(detail.workflow.plugin.id)}`}><Share2 className="h-3.5 w-3.5" />Manage sharing</DenButton> : null}
        </div>
      </header>

      {actionError ? <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-[13px] text-red-600">{actionError.message}</div> : null}

      <nav className="flex gap-1 overflow-x-auto rounded-xl border border-gray-100 bg-white p-1 text-[12px] text-gray-500">
        {[["overview", "Overview"], ["preview-data", "Result"], ["how-it-works", "How it works"], ["views", "Display"], ["runs", "Runs"], ["access", "Sharing"]].map(([id, label]) => <a key={id} href={`#${id}`} className="shrink-0 rounded-lg px-3 py-2 hover:bg-gray-50 hover:text-gray-900">{label}</a>)}
      </nav>

      <section id="overview" className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {overview.map((item) => <div key={item.label} className="rounded-2xl border border-gray-100 bg-white p-4"><p className="text-[11px] font-medium uppercase tracking-wide text-gray-400">{item.label}</p><p className="mt-2 text-[14px] font-medium text-gray-800">{item.value}</p>{item.description ? <p className="mt-1 text-[11px] text-gray-400">{item.description}</p> : null}</div>)}
      </section>

      <section id="views" className="rounded-2xl border border-gray-100 bg-white p-5">
        <div className="flex items-start justify-between gap-3"><div><h2 className="flex items-center gap-2 text-[15px] font-semibold text-gray-900"><Layers3 className="h-4 w-4" />Custom display</h2><p className="mt-1 text-[12px] text-gray-400">Show this workflow&apos;s results as a chart, table, or card layout designed by your agent. Until then results use the standard view.</p></div><DenChip tone="neutral">{detail.views.length} display{detail.views.length === 1 ? "" : "s"}</DenChip></div>
        <div className="mt-4 space-y-4">
          {detail.views.length === 0 ? <p className="rounded-xl border border-dashed border-gray-200 p-6 text-center text-[13px] text-gray-400">No custom display yet. In OpenWork chat, ask: “Design a display for the {detail.workflow.name} workflow.”</p> : detail.views.map((view) => (
            <article key={view.id} className="rounded-xl border border-gray-100 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex items-center gap-2"><h3 className="text-[13px] font-semibold text-gray-800">{view.title}</h3><DenChip tone={view.status === "active" ? "success" : "neutral"}>{view.status === "active" ? "In use" : "Not in use"}</DenChip></div><p className="mt-1 text-[12px] text-gray-400">{view.description || "A custom layout for this workflow's results."}</p></div>{manager && view.status === "active" ? <DenButton variant="destructive" size="sm" loading={retire.isPending} onClick={() => void retire.mutateAsync(view.id)}>Stop using</DenButton> : null}</div>
              <div className="mt-3 space-y-2">{view.revisions.map((revision) => {
                const active = revision.id === view.activeRevisionId;
                return <div key={revision.id} className="rounded-lg bg-gray-50 p-3 text-[11px] text-gray-500"><div className="flex flex-wrap items-center justify-between gap-2"><div className="flex items-center gap-2"><History className="h-3.5 w-3.5" /><span>{new Date(revision.createdAt).toLocaleString()}</span><DenChip tone={revision.buildStatus === "ready" ? active ? "success" : "neutral" : "danger"}>{active ? "In use" : revision.buildStatus === "ready" ? "Ready" : "Could not build"}</DenChip></div>{manager && revision.buildStatus === "ready" && !active && revision.retiredAt === null ? <DenButton size="xs" variant="secondary" loading={activate.isPending} onClick={() => void activate.mutateAsync({ viewId: view.id, revisionId: revision.id })}>Use this version</DenButton> : null}</div><details className="mt-2 rounded-lg border border-gray-200 bg-white p-2"><summary className="cursor-pointer font-medium text-gray-600">Technical details</summary><p className="mt-2 break-all font-mono text-[10px] text-gray-500">{revision.id}</p><div className="mt-2 grid gap-1 md:grid-cols-2 xl:grid-cols-4"><span>{revision.compilerName} {revision.compilerVersion}</span><span>React {revision.reactVersion}</span><span>{revision.compiledHtmlBytes === null ? "No compiled bundle" : `${revision.compiledHtmlBytes.toLocaleString()} bytes`}</span><span>{new Date(revision.createdAt).toLocaleString()}</span><span className="md:col-span-2">Source {shortDigest(revision.sourceDigest)}</span><span className="md:col-span-2">Resource {shortDigest(revision.resourceDigest)}</span><span className="md:col-span-2 xl:col-span-4">{cspSummary(revision.csp)}</span></div><p className="mt-2 break-all font-mono text-[10px] text-gray-400">{revision.resourceUri}</p>{revision.diagnostics.length ? <ul className="mt-2 space-y-1 text-red-600">{revision.diagnostics.map((diagnostic, index) => <li key={`${diagnostic.message}-${index}`}>{diagnostic.level}: {diagnostic.message}{diagnostic.line ? ` (${diagnostic.line}:${diagnostic.column ?? 0})` : ""}</li>)}</ul> : null}</details></div>;
              })}</div>
            </article>
          ))}
        </div>
      </section>

      <WorkflowDetailPanel configObjectId={workflowId} onClose={() => router.push("/dashboard/library")} />

      <section id="access" className="rounded-2xl border border-gray-100 bg-white p-5"><h2 className="text-[14px] font-semibold text-gray-900">Sharing</h2><p className="mt-2 text-[13px] text-gray-500">{canEdit ? "You can edit this workflow." : "You can run this workflow."}</p>{manager && detail.workflow.plugin ? <DenButton className="mt-4" variant="secondary" href={`/dashboard/plugins/${encodeURIComponent(detail.workflow.plugin.id)}`}>Manage sharing</DenButton> : null}</section>
    </div>
  );
}
