"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, RefreshCw, Save, TestTube2, Trash2 } from "lucide-react";
import type { WorkflowArtifactSnapshot, WorkflowCapability, WorkflowDetail, WorkflowTestResult } from "@openwork/types/workflows";
import { DenButton } from "../../_components/ui/button";
import { DenInput } from "../../_components/ui/input";
import { DenTextarea } from "../../_components/ui/textarea";
import { WorkflowArtifactResult, WorkflowMarkdownPreview } from "./workflow-artifact-result";
import { WorkflowFlowDiagram } from "./workflow-flow-diagram";
import { formFieldsFromSchema, WorkflowInputForm } from "./workflow-input-form";
import { describeToolStep, summarizeGraph } from "./workflow-plain-language";
import {
  type WorkflowDraft,
  useDeleteWorkflowSnapshot,
  useRunWorkflow,
  useSaveWorkflowVersion,
  useTestWorkflow,
  useUpdateWorkflowAutomation,
  useWorkflowDetail,
  useWorkflowSnapshots,
} from "./workflow-data";

type Fields = { name: string; description: string; code: string; input: string; inputSchema: string; outputSchema: string };
const AGE_OPTIONS = [{ label: "1 hour", value: 3_600_000 }, { label: "1 day", value: 86_400_000 }, { label: "1 week", value: 604_800_000 }];

function pretty(value: unknown) {
  return value === null || value === undefined ? "" : JSON.stringify(value, null, 2);
}

function initialFields(detail: WorkflowDetail): Fields {
  return { name: detail.title, description: detail.description ?? "", code: detail.currentVersion.code ?? "", input: pretty(detail.currentVersion.exampleInput ?? {}), inputSchema: pretty(detail.currentVersion.inputSchema), outputSchema: pretty(detail.currentVersion.outputSchema) };
}

function parseJson(label: string, value: string, optional = false) {
  if (!value.trim() && optional) return undefined;
  try { return JSON.parse(value.trim() || "null"); } catch { throw new Error(`${label}: check the format and try again.`); }
}

function parseJsonLenient(value: string): unknown {
  try { return JSON.parse(value); } catch { return null; }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formValue(value: string): Record<string, unknown> {
  const parsed = parseJsonLenient(value);
  return isPlainObject(parsed) ? parsed : {};
}

function diagramInput(snapshot: WorkflowArtifactSnapshot | null, exampleInput: unknown): Record<string, unknown> | undefined {
  if (snapshot && "input" in snapshot && isPlainObject(snapshot.input)) return snapshot.input;
  return isPlainObject(exampleInput) ? exampleInput : undefined;
}

function toDraft(detail: WorkflowDetail, fields: Fields): WorkflowDraft {
  return {
    name: fields.name.trim(),
    description: fields.description.trim() || undefined,
    code: fields.code,
    exampleInput: parseJson("Example input", fields.input),
    inputSchema: parseJson("What it needs", fields.inputSchema, true),
    outputSchema: parseJson("What it returns", fields.outputSchema, true),
    requiredCapabilities: detail.currentVersion.requiredCapabilities,
  };
}

function message(error: unknown) {
  return error instanceof Error ? error.message : "That action did not work. Please try again.";
}

function freshnessLabel(state: WorkflowDetail["freshness"]["state"]): string {
  if (state === "fresh") return "Up to date";
  if (state === "stale") return "Last run was a while ago";
  if (state === "needs_attention") return "Needs attention";
  return "Not run yet";
}

function capabilityDescription(capability: WorkflowCapability): { title: string; service: string } {
  const path = capability.scriptPath.replace(/^tools\./, "").split(".");
  const namespace = path[0] ?? "";
  const tool = path.at(-1) ?? capability.capabilityName;
  return describeToolStep({
    id: capability.capabilityName,
    kind: "tool",
    label: capability.capabilityName,
    namespace,
    tool,
    scriptPath: capability.scriptPath,
    assignsTo: null,
    parallelGroup: null,
  });
}

export function WorkflowDetailPanel({ configObjectId, onClose }: { configObjectId: string; onClose: () => void }) {
  const [maxAgeMs, setMaxAgeMs] = useState(86_400_000);
  const detailQuery = useWorkflowDetail(configObjectId, maxAgeMs);
  const snapshotsQuery = useWorkflowSnapshots(configObjectId);
  const testMutation = useTestWorkflow(configObjectId);
  const saveMutation = useSaveWorkflowVersion(configObjectId);
  const runMutation = useRunWorkflow(configObjectId);
  const deleteMutation = useDeleteWorkflowSnapshot(configObjectId);
  const updateAutomation = useUpdateWorkflowAutomation(configObjectId);
  const [fields, setFields] = useState<Fields | null>(null);
  const [base, setBase] = useState("");
  const [tested, setTested] = useState<{ result: WorkflowTestResult; fingerprint: string } | null>(null);
  const [selectedReceiptId, setSelectedReceiptId] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [loadedVersion, setLoadedVersion] = useState<string | null>(null);
  const [showJsonInput, setShowJsonInput] = useState(false);
  const [technical, setTechnical] = useState(false);
  const detail = detailQuery.data;
  const versionKey = detail?.currentVersion.id;

  useEffect(() => {
    if (!detail || detail.currentVersion.id === loadedVersion) return;
    const next = initialFields(detail);
    setFields(next);
    setBase(JSON.stringify(next));
    setTested(null);
    setShowJsonInput(false);
    setSelectedReceiptId(detail.latestSnapshot?.receiptId ?? detail.latestSuccessfulSnapshot?.receiptId ?? null);
    setLoadedVersion(detail.currentVersion.id);
  }, [detail, loadedVersion, versionKey]);

  const fingerprint = fields ? JSON.stringify(fields) : "";
  const dirty = Boolean(fields && fingerprint !== base);
  const snapshots = snapshotsQuery.data ?? [];
  const selected = snapshots.find((snapshot) => snapshot.receiptId === selectedReceiptId) ?? detail?.latestSuccessfulSnapshot ?? null;
  const pending = testMutation.isPending || saveMutation.isPending || runMutation.isPending || deleteMutation.isPending || updateAutomation.isPending;
  const error = localError ?? [testMutation.error, saveMutation.error, runMutation.error, deleteMutation.error, updateAutomation.error, detailQuery.error, snapshotsQuery.error].find(Boolean);

  const update = (key: keyof Fields, value: string) => {
    setFields((current) => current ? { ...current, [key]: value } : current);
    setTested(null);
    setLocalError(null);
  };
  const close = () => {
    if (dirty && !window.confirm("Discard your unsaved changes?")) return;
    onClose();
  };

  const currentAutomationCount = useMemo(() => detail?.versions.reduce((sum, version) => sum + version.automationReferences.length, 0) ?? 0, [detail]);

  if (detailQuery.isLoading || !detail || !fields) return <div className="rounded-2xl border border-gray-100 bg-white p-6 text-[13px] text-gray-400">{error ? message(error) : "Loading workflow…"}</div>;

  const parsedInputSchema = detail.canManage ? parseJsonLenient(fields.inputSchema) : detail.currentVersion.inputSchema;
  const hasInputForm = formFieldsFromSchema(parsedInputSchema) !== null;
  const inputFormValue = formValue(fields.input);
  const graphSummary = detail.currentVersion.graph ? summarizeGraph(detail.currentVersion.graph) : null;
  const flowInput = diagramInput(selected, detail.currentVersion.exampleInput);
  const runNow = () => {
    setLocalError(null);
    try {
      const input = parseJson("Run details", fields.input);
      void runMutation.mutateAsync({ pluginId: detail.pluginId, configObjectVersionId: detail.currentVersion.id, input }).catch((reason) => setLocalError(message(reason)));
    } catch (reason) {
      setLocalError(message(reason));
    }
  };

  return (
    <div className="space-y-5" data-testid="den-workflow-detail-panel">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <button type="button" aria-label="Back to Library" onClick={close} className="mt-0.5 rounded-lg p-2 text-gray-400 hover:bg-gray-50 hover:text-gray-800"><ArrowLeft className="h-4 w-4" /></button>
          <div><div className="flex flex-wrap items-center gap-2"><h1 className="text-[18px] font-semibold text-gray-950">{detail.title}</h1><span className={`rounded-full px-2 py-0.5 text-[11px] ${detail.freshness.state === "needs_attention" ? "bg-red-50 text-red-600" : detail.freshness.state === "fresh" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>{freshnessLabel(detail.freshness.state)}</span></div><p className="mt-1 text-[13px] text-gray-400">A saved workflow used by {currentAutomationCount} schedule{currentAutomationCount === 1 ? "" : "s"}.</p></div>
        </div>
        <label className="flex items-center gap-2 text-[12px] text-gray-500">Mark results out of date after<select value={maxAgeMs} onChange={(event) => setMaxAgeMs(Number(event.currentTarget.value))} className="h-9 rounded-xl border border-gray-200 bg-white px-2 text-[13px] text-gray-700">{AGE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
      </div>

      {error ? <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-[13px] text-red-600">{message(error)}</div> : null}
      {detail.freshness.state === "needs_attention" ? <div className="rounded-xl border border-amber-100 bg-amber-50 px-4 py-3 text-[13px] text-amber-700">{detail.freshness.reason} You can still open the last successful result.</div> : null}

      <section id="how-it-works" className="rounded-2xl border border-gray-100 bg-white p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><h2 className="text-[14px] font-semibold text-gray-900">How it works</h2><p className="mt-1 max-w-3xl text-[12px] text-gray-400">{graphSummary?.sentence ?? "A picture of this workflow is not available yet."}</p></div>
          <div className="flex items-center gap-3">
            {graphSummary ? <span className="rounded-full bg-gray-100 px-2 py-1 text-[11px] text-gray-600">{graphSummary.stepCount} step{graphSummary.stepCount === 1 ? "" : "s"}</span> : null}
            <label className="flex items-center gap-1.5 text-[11px] text-gray-500"><input type="checkbox" checked={technical} onChange={(event) => setTechnical(event.currentTarget.checked)} />Show technical details</label>
          </div>
        </div>
        {detail.currentVersion.graph ? <WorkflowFlowDiagram graph={detail.currentVersion.graph} technical={technical} inputValues={flowInput} run={selected ? { toolCalls: selected.toolCalls, status: selected.status, errorMessage: selected.errorMessage, finishedAt: selected.finishedAt } : null} /> : null}
      </section>

      <section className="rounded-2xl border border-gray-100 bg-white p-5">
        <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-[14px] font-semibold text-gray-900">Run it</h2><p className="mt-1 text-[12px] text-gray-400">Fill in the details and run. Each run keeps its result below.</p></div>{detail.canRun ? <DenButton disabled={pending} onClick={runNow}><RefreshCw className="h-3.5 w-3.5" />Run now</DenButton> : null}</div>
        {detail.canRun ? hasInputForm ? <div className="mt-4"><p className="text-[12px] font-medium text-gray-600">Run input</p><WorkflowInputForm schema={parsedInputSchema} value={inputFormValue} onChange={(next) => update("input", JSON.stringify(next, null, 2))} />{technical ? <div className="mt-2"><button type="button" onClick={() => setShowJsonInput((current) => !current)} className="text-[11px] text-gray-400 hover:text-gray-700">{showJsonInput ? "Hide formatted input" : "Edit formatted input"}</button>{showJsonInput ? <DenTextarea aria-label="Run input details" className="mt-2 min-h-32 font-mono text-[11px]" value={fields.input} onChange={(event) => update("input", event.currentTarget.value)} /> : null}</div> : null}</div> : technical ? <label className="mt-4 block text-[12px] font-medium text-gray-600">Run input<DenTextarea className="mt-1 min-h-32 font-mono text-[11px]" value={fields.input} onChange={(event) => update("input", event.currentTarget.value)} /></label> : <p className="mt-4 text-[12px] text-gray-500">Show technical details to enter the run input for this workflow.</p> : <p className="mt-4 text-[12px] text-gray-500">You do not have permission to run this workflow.</p>}
      </section>

      <section id="preview-data" className="rounded-2xl border border-gray-100 bg-white p-5"><h2 className="text-[14px] font-semibold text-gray-900">Latest result</h2><p className="mt-1 text-[12px] text-gray-400">This is the saved result from the run you selected.</p><div className="mt-4">{selected ? <WorkflowArtifactResult snapshot={selected} freshness={selected.receiptId === detail.latestSnapshot?.receiptId ? detail.freshness : undefined} lastSuccessful={selected.receiptId === detail.latestSuccessfulSnapshot?.receiptId} /> : <p className="text-[13px] text-gray-400">Run this workflow to see its first result.</p>}</div></section>

      {detail.canManage ? <details className="rounded-2xl border border-gray-100 bg-white p-5">
        <summary className="cursor-pointer text-[14px] font-semibold text-gray-900">Advanced: edit the code</summary>
        <p className="mt-2 text-[12px] text-gray-400">Test your change first; when it passes you can save it as a new version.</p>
        <div className="mt-4 space-y-4">
          <div className="grid gap-3 sm:grid-cols-2"><label className="text-[12px] font-medium text-gray-600">Name<DenInput className="mt-1" value={fields.name} onChange={(event) => update("name", event.currentTarget.value)} /></label><label className="text-[12px] font-medium text-gray-600">Description<DenInput className="mt-1" value={fields.description} onChange={(event) => update("description", event.currentTarget.value)} /></label></div>
          <label className="block text-[12px] font-medium text-gray-600">Code<DenTextarea className="mt-1 min-h-72 font-mono text-[12px]" value={fields.code} onChange={(event) => update("code", event.currentTarget.value)} /></label>
          {hasInputForm ? <div><p className="text-[12px] font-medium text-gray-600">Example input</p><WorkflowInputForm schema={parsedInputSchema} value={inputFormValue} onChange={(next) => update("input", JSON.stringify(next, null, 2))} />{technical ? <DenTextarea aria-label="Example input details" className="mt-2 min-h-36 font-mono text-[11px]" value={fields.input} onChange={(event) => update("input", event.currentTarget.value)} /> : null}</div> : <label className="block text-[12px] font-medium text-gray-600">Example input<DenTextarea className="mt-1 min-h-36 font-mono text-[11px]" value={fields.input} onChange={(event) => update("input", event.currentTarget.value)} /></label>}
          <div className="grid gap-3 lg:grid-cols-2"><label className="text-[12px] font-medium text-gray-600">What it needs<DenTextarea className="mt-1 min-h-36 font-mono text-[11px]" value={fields.inputSchema} onChange={(event) => update("inputSchema", event.currentTarget.value)} /></label><label className="text-[12px] font-medium text-gray-600">What it returns<DenTextarea className="mt-1 min-h-36 font-mono text-[11px]" value={fields.outputSchema} onChange={(event) => update("outputSchema", event.currentTarget.value)} /></label></div>
          <div><p className="text-[12px] font-medium text-gray-600">Uses these tools</p><div className="mt-2 flex flex-wrap gap-2">{detail.currentVersion.requiredCapabilities.length === 0 ? <span className="rounded-full bg-gray-100 px-2 py-1 text-[11px] text-gray-500">No outside tools</span> : detail.currentVersion.requiredCapabilities.map((capability) => {
            const description = capabilityDescription(capability);
            return <span key={`${capability.capabilityName}:${capability.scriptPath}`} className="rounded-lg bg-gray-100 px-2 py-1 text-[11px] text-gray-600"><strong className="font-medium text-gray-700">{description.title}</strong> · {description.service}{technical ? <span className="mt-0.5 block font-mono text-[10px] text-gray-400">{capability.scriptPath}</span> : null}</span>;
          })}</div></div>
          <div className="flex justify-end gap-2"><DenButton variant="secondary" disabled={pending} onClick={() => { setLocalError(null); const draft = toDraft(detail, fields); void testMutation.mutateAsync(draft).then((result) => setTested({ result, fingerprint })).catch((reason) => setLocalError(message(reason))); }}><TestTube2 className="h-3.5 w-3.5" />Test changes</DenButton><DenButton disabled={pending || tested?.fingerprint !== fingerprint} onClick={() => { if (!tested) return; const draft = toDraft(detail, fields); void saveMutation.mutateAsync({ receiptId: tested.result.receiptId, draft }).catch((reason) => setLocalError(message(reason))); }}><Save className="h-3.5 w-3.5" />Save new version</DenButton></div>
          {tested ? <div className="rounded-xl border border-gray-100 p-4"><h3 className="text-[13px] font-semibold text-gray-900">Test result</h3><div className="mt-3 grid gap-4 lg:grid-cols-2"><div><p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-gray-400">Preview</p><WorkflowMarkdownPreview markdown={tested.result.markdown} /></div><div><p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-gray-400">Data</p><pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-xl bg-gray-950 p-3 font-mono text-[11px] text-gray-100">{JSON.stringify(tested.result.value, null, 2)}</pre></div></div></div> : null}
        </div>
      </details> : null}

      <div id="runs" className="grid gap-5 lg:grid-cols-2">
        <section className="rounded-2xl border border-gray-100 bg-white p-5"><h2 className="text-[14px] font-semibold text-gray-900">Versions</h2><div className="mt-3 space-y-3">{detail.versions.map((version, index) => <div key={version.id} className="rounded-xl border border-gray-100 p-3 text-[11px]"><div className="flex justify-between gap-2"><span className="font-medium text-gray-700">{index === 0 ? "Current" : "Earlier"}</span><span className="text-gray-400">{new Date(version.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</span></div>{technical ? <p className="mt-1 break-all font-mono text-gray-400">{version.id}</p> : null}<p className="mt-1 text-gray-400">Used by {version.automationReferences.length} schedule{version.automationReferences.length === 1 ? "" : "s"}</p>{detail.canManage && index > 0 ? version.automationReferences.map((reference) => <button key={reference.id} type="button" className="mt-2 w-full rounded-lg border border-gray-200 px-2 py-1.5 text-left text-gray-600 hover:bg-gray-50" onClick={() => { if (!window.confirm(`Update ${reference.name} to the current version? Its schedule and saved input will stay the same.`)) return; void updateAutomation.mutateAsync({ automationId: reference.id, pluginId: detail.pluginId, configObjectVersionId: detail.currentVersion.id, input: reference.input }).catch((reason) => setLocalError(message(reason))); }}>Update to current version · {reference.name}</button>) : null}</div>)}</div></section>
        <section className="rounded-2xl border border-gray-100 bg-white p-5"><h2 className="text-[14px] font-semibold text-gray-900">Past runs</h2><p className="mt-1 text-[12px] text-gray-400">Click a run to see which steps it took.</p><div className="mt-3 space-y-2">{snapshots.map((snapshot) => <div key={snapshot.receiptId} className="flex items-center gap-2 rounded-xl border border-gray-100 p-2"><button type="button" className="min-w-0 flex-1 text-left" onClick={() => setSelectedReceiptId(snapshot.receiptId)}><span className={`rounded-full px-2 py-0.5 text-[10px] ${snapshot.status === "failed" ? "bg-red-50 text-red-600" : "bg-emerald-50 text-emerald-700"}`}>{snapshot.status === "failed" ? "Failed" : "Succeeded"}</span>{snapshot.contentDeletedAt ? <span className="ml-1 rounded-full bg-gray-100 px-2 py-0.5 text-[10px] text-gray-400">Result removed</span> : null}<span className="mt-1 block truncate text-[11px] text-gray-400">{new Date(snapshot.finishedAt).toLocaleString()} · {snapshot.source === "manual" ? "Manual" : "Scheduled"}</span>{technical ? <span className="mt-1 block truncate font-mono text-[10px] text-gray-300">{snapshot.receiptId}</span> : null}</button>{!snapshot.contentDeletedAt && detail.canManage ? <button type="button" aria-label="Delete this run's saved result" className="rounded-lg p-2 text-gray-400 hover:bg-red-50 hover:text-red-600" onClick={() => { if (!window.confirm("Delete this run's saved input and result? Its date and status will remain.")) return; void deleteMutation.mutateAsync(snapshot.receiptId).catch((reason) => setLocalError(message(reason))); }}><Trash2 className="h-3.5 w-3.5" /></button> : null}</div>)}</div></section>
      </div>
    </div>
  );
}
