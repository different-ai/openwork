"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, RefreshCw, Save, TestTube2, Trash2 } from "lucide-react";
import type { WorkflowDetail, WorkflowTestResult } from "@openwork/types/workflows";
import { DenButton } from "../../_components/ui/button";
import { DenInput } from "../../_components/ui/input";
import { DenTextarea } from "../../_components/ui/textarea";
import { WorkflowArtifactResult, WorkflowMarkdownPreview } from "./workflow-artifact-result";
import { WorkflowFlowDiagram } from "./workflow-flow-diagram";
import { formFieldsFromSchema, WorkflowInputForm } from "./workflow-input-form";
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
  try { return JSON.parse(value.trim() || "null"); } catch { throw new Error(`${label} syntax: enter valid JSON.`); }
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

function toDraft(detail: WorkflowDetail, fields: Fields): WorkflowDraft {
  return {
    name: fields.name.trim(),
    description: fields.description.trim() || undefined,
    code: fields.code,
    exampleInput: parseJson("Example input", fields.input),
    inputSchema: parseJson("Input schema", fields.inputSchema, true),
    outputSchema: parseJson("Output schema", fields.outputSchema, true),
    requiredCapabilities: detail.currentVersion.requiredCapabilities,
  };
}

function message(error: unknown) {
  return error instanceof Error ? error.message : "The Workflow action failed.";
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
    if (dirty && !window.confirm("Discard unsaved Workflow changes?")) return;
    onClose();
  };

  const currentAutomationCount = useMemo(() => detail?.versions.reduce((sum, version) => sum + version.automationReferences.length, 0) ?? 0, [detail]);

  if (detailQuery.isLoading || !detail || !fields) return <div className="rounded-2xl border border-gray-100 bg-white p-6 text-[13px] text-gray-400">{error ? message(error) : "Loading Workflow…"}</div>;

  const parsedInputSchema = detail.canManage ? parseJsonLenient(fields.inputSchema) : detail.currentVersion.inputSchema;
  const hasInputForm = formFieldsFromSchema(parsedInputSchema) !== null;
  const inputFormValue = formValue(fields.input);

  return (
    <div className="space-y-5" data-testid="den-workflow-detail-panel">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <button type="button" aria-label="Back to Library" onClick={close} className="mt-0.5 rounded-lg p-2 text-gray-400 hover:bg-gray-50 hover:text-gray-800"><ArrowLeft className="h-4 w-4" /></button>
          <div><div className="flex flex-wrap items-center gap-2"><h1 className="text-[18px] font-semibold text-gray-950">{detail.title}</h1><span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-500">Version {detail.currentVersion.id.slice(0, 8)}</span><span className={`rounded-full px-2 py-0.5 text-[11px] ${detail.freshness.state === "needs_attention" ? "bg-red-50 text-red-600" : detail.freshness.state === "fresh" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>{detail.freshness.state.replace("_", " ")}</span></div><p className="mt-1 text-[13px] text-gray-400">Durable, versioned Workflow · {currentAutomationCount} pinned Automation{currentAutomationCount === 1 ? "" : "s"}</p></div>
        </div>
        <div className="flex flex-wrap gap-2"><label className="flex items-center gap-2 text-[12px] text-gray-400">Stale after<select value={maxAgeMs} onChange={(event) => setMaxAgeMs(Number(event.currentTarget.value))} className="h-9 rounded-xl border border-gray-200 bg-white px-2 text-[13px] text-gray-700">{AGE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>{detail.canRun ? <DenButton disabled={pending} onClick={() => { setLocalError(null); void runMutation.mutateAsync({ pluginId: detail.pluginId, configObjectVersionId: detail.currentVersion.id, input: parseJson("Run input", fields.input) }).catch((reason) => setLocalError(message(reason))); }}><RefreshCw className="h-3.5 w-3.5" />Run now</DenButton> : null}</div>
      </div>

      {error ? <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-[13px] text-red-600">{message(error)}</div> : null}
      {detail.freshness.state === "needs_attention" ? <div className="rounded-xl border border-amber-100 bg-amber-50 px-4 py-3 text-[13px] text-amber-700">{detail.freshness.reason} The last successful result remains readable.</div> : null}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(21rem,0.8fr)]">
        <div className="space-y-5">
          {detail.currentVersion.graph ? <section className="rounded-2xl border border-gray-100 bg-white p-5">
            <h2 className="text-[14px] font-semibold text-gray-900">Flow</h2>
            <p className="mt-1 text-[12px] text-gray-400">Each step is a tool call in the saved version. Branches and parallel work are shown as a structural preview.</p>
            <WorkflowFlowDiagram graph={detail.currentVersion.graph} run={selected ? { toolCalls: selected.toolCalls, status: selected.status, errorMessage: selected.errorMessage, finishedAt: selected.finishedAt } : null} />
          </section> : null}

          {detail.canManage ? <section className="rounded-2xl border border-gray-100 bg-white p-5">
            <div className="mb-4"><h2 className="text-[14px] font-semibold text-gray-900">Script editor</h2><p className="mt-1 text-[12px] text-gray-400">A matching successful test is required before a new immutable version can be saved.</p></div>
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2"><label className="text-[12px] font-medium text-gray-600">Name<DenInput className="mt-1" value={fields.name} onChange={(event) => update("name", event.currentTarget.value)} /></label><label className="text-[12px] font-medium text-gray-600">Description<DenInput className="mt-1" value={fields.description} onChange={(event) => update("description", event.currentTarget.value)} /></label></div>
              <label className="block text-[12px] font-medium text-gray-600">Source<DenTextarea className="mt-1 min-h-72 font-mono text-[12px]" value={fields.code} onChange={(event) => update("code", event.currentTarget.value)} /></label>
              {hasInputForm ? <div><div className="flex items-center justify-between gap-3"><p className="text-[12px] font-medium text-gray-600">Example input</p><button type="button" onClick={() => setShowJsonInput((current) => !current)} className="text-[11px] text-gray-400 hover:text-gray-700">{showJsonInput ? "Hide JSON" : "Edit as JSON"}</button></div><WorkflowInputForm schema={parsedInputSchema} value={inputFormValue} onChange={(next) => update("input", JSON.stringify(next, null, 2))} />{showJsonInput ? <DenTextarea aria-label="Example input JSON" className="mt-2 min-h-36 font-mono text-[11px]" value={fields.input} onChange={(event) => update("input", event.currentTarget.value)} /> : null}</div> : <label className="block text-[12px] font-medium text-gray-600">Example input<DenTextarea className="mt-1 min-h-36 font-mono text-[11px]" value={fields.input} onChange={(event) => update("input", event.currentTarget.value)} /></label>}
              <div className="grid gap-3 lg:grid-cols-2"><label className="text-[12px] font-medium text-gray-600">Input schema<DenTextarea className="mt-1 min-h-36 font-mono text-[11px]" value={fields.inputSchema} onChange={(event) => update("inputSchema", event.currentTarget.value)} /></label><label className="text-[12px] font-medium text-gray-600">Output schema<DenTextarea className="mt-1 min-h-36 font-mono text-[11px]" value={fields.outputSchema} onChange={(event) => update("outputSchema", event.currentTarget.value)} /></label></div>
              <div><p className="text-[12px] font-medium text-gray-600">Required capabilities</p><div className="mt-2 flex flex-wrap gap-2">{detail.currentVersion.requiredCapabilities.length === 0 ? <span className="rounded-full bg-gray-100 px-2 py-1 text-[11px] text-gray-500">No provider tools</span> : detail.currentVersion.requiredCapabilities.map((capability) => <span key={`${capability.capabilityName}:${capability.scriptPath}`} className="rounded-full bg-gray-100 px-2 py-1 font-mono text-[11px] text-gray-600">{capability.scriptPath}</span>)}</div></div>
              <div className="flex justify-end gap-2"><DenButton variant="secondary" disabled={pending} onClick={() => { setLocalError(null); const draft = toDraft(detail, fields); void testMutation.mutateAsync(draft).then((result) => setTested({ result, fingerprint })).catch((reason) => setLocalError(message(reason))); }}><TestTube2 className="h-3.5 w-3.5" />Test changes</DenButton><DenButton disabled={pending || tested?.fingerprint !== fingerprint} onClick={() => { if (!tested) return; const draft = toDraft(detail, fields); void saveMutation.mutateAsync({ receiptId: tested.result.receiptId, draft }).catch((reason) => setLocalError(message(reason))); }}><Save className="h-3.5 w-3.5" />Save new version</DenButton></div>
            </div>
          </section> : <section className="rounded-2xl border border-gray-100 bg-white p-5">
            <h2 className="text-[14px] font-semibold text-gray-900">Script</h2>
            <p className="mt-1 text-[12px] text-gray-400">Source and saved example input are authoring details visible only to Workflow managers.</p>
            {detail.canRun ? hasInputForm ? <div className="mt-4"><div className="flex items-center justify-between gap-3"><p className="text-[12px] font-medium text-gray-600">Run input</p><button type="button" onClick={() => setShowJsonInput((current) => !current)} className="text-[11px] text-gray-400 hover:text-gray-700">{showJsonInput ? "Hide JSON" : "Edit as JSON"}</button></div><WorkflowInputForm schema={parsedInputSchema} value={inputFormValue} onChange={(next) => update("input", JSON.stringify(next, null, 2))} />{showJsonInput ? <DenTextarea aria-label="Run input JSON" className="mt-2 min-h-32 font-mono text-[11px]" value={fields.input} onChange={(event) => update("input", event.currentTarget.value)} /> : null}</div> : <label className="mt-4 block text-[12px] font-medium text-gray-600">Run input<DenTextarea className="mt-1 min-h-32 font-mono text-[11px]" value={fields.input} onChange={(event) => update("input", event.currentTarget.value)} /></label> : null}
            <div className="mt-4 grid gap-3 lg:grid-cols-2"><div><p className="text-[12px] font-medium text-gray-600">Input schema</p><pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-xl bg-gray-950 p-3 font-mono text-[11px] text-gray-100">{fields.inputSchema || "No input schema"}</pre></div><div><p className="text-[12px] font-medium text-gray-600">Output schema</p><pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-xl bg-gray-950 p-3 font-mono text-[11px] text-gray-100">{fields.outputSchema || "No output schema"}</pre></div></div>
          </section>}

          {tested ? <section className="rounded-2xl border border-gray-100 bg-white p-5"><h2 className="text-[14px] font-semibold text-gray-900">Test output</h2><div className="mt-3 grid gap-4 lg:grid-cols-2"><div><p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-gray-400">Preview</p><WorkflowMarkdownPreview markdown={tested.result.markdown} /></div><div><p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-gray-400">Data</p><pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-xl bg-gray-950 p-3 font-mono text-[11px] text-gray-100">{JSON.stringify(tested.result.value, null, 2)}</pre></div></div></section> : null}

          <section id="preview-data" className="rounded-2xl border border-gray-100 bg-white p-5"><h2 className="text-[14px] font-semibold text-gray-900">Artifact result</h2><p className="mt-1 text-[12px] text-gray-400">The same Preview, Data, and Lineage contract is available on desktop and Web.</p><div className="mt-4">{selected ? <WorkflowArtifactResult snapshot={selected} freshness={selected.receiptId === detail.latestSnapshot?.receiptId ? detail.freshness : undefined} lastSuccessful={selected.receiptId === detail.latestSuccessfulSnapshot?.receiptId} /> : <p className="text-[13px] text-gray-400">No retained result yet.</p>}</div></section>
        </div>

        <div id="runs" className="space-y-5">
          <section className="rounded-2xl border border-gray-100 bg-white p-5"><h2 className="text-[14px] font-semibold text-gray-900">Version history</h2><div className="mt-3 space-y-3">{detail.versions.map((version, index) => <div key={version.id} className="rounded-xl border border-gray-100 p-3 text-[11px]"><div className="flex justify-between gap-2"><span className="font-mono text-gray-700">{version.id.slice(0, 12)}</span><span className="text-gray-400">{index === 0 ? "Current" : "Earlier"}</span></div><p className="mt-1 text-gray-400">{new Date(version.createdAt).toLocaleString()} · {version.automationReferences.length} Automation{version.automationReferences.length === 1 ? "" : "s"}</p>{detail.canManage && index > 0 ? version.automationReferences.map((reference) => <button key={reference.id} type="button" className="mt-2 w-full rounded-lg border border-gray-200 px-2 py-1.5 text-left text-gray-600 hover:bg-gray-50" onClick={() => { if (!window.confirm(`Update ${reference.name} from ${version.id} to ${detail.currentVersion.id}? The schedule and valid input will be preserved.`)) return; void updateAutomation.mutateAsync({ automationId: reference.id, pluginId: detail.pluginId, configObjectVersionId: detail.currentVersion.id, input: reference.input }).catch((reason) => setLocalError(message(reason))); }}>Update Automation… · {reference.name}</button>) : null}</div>)}</div></section>
          <section className="rounded-2xl border border-gray-100 bg-white p-5"><h2 className="text-[14px] font-semibold text-gray-900">Snapshot history</h2><div className="mt-3 space-y-2">{snapshots.map((snapshot) => <div key={snapshot.receiptId} className="flex items-center gap-2 rounded-xl border border-gray-100 p-2"><button type="button" className="min-w-0 flex-1 text-left" onClick={() => setSelectedReceiptId(snapshot.receiptId)}><span className={`rounded-full px-2 py-0.5 text-[10px] ${snapshot.status === "failed" ? "bg-red-50 text-red-600" : "bg-gray-100 text-gray-600"}`}>{snapshot.status}</span>{snapshot.contentDeletedAt ? <span className="ml-1 rounded-full bg-gray-100 px-2 py-0.5 text-[10px] text-gray-400">Content deleted</span> : null}<span className="mt-1 block truncate text-[11px] text-gray-400">{new Date(snapshot.finishedAt).toLocaleString()} · {snapshot.source}</span></button>{!snapshot.contentDeletedAt && detail.canManage ? <button type="button" aria-label="Delete snapshot content" className="rounded-lg p-2 text-gray-400 hover:bg-red-50 hover:text-red-600" onClick={() => { if (!window.confirm("Delete this snapshot's input, JSON, and Markdown? Audit facts will remain.")) return; void deleteMutation.mutateAsync(snapshot.receiptId).catch((reason) => setLocalError(message(reason))); }}><Trash2 className="h-3.5 w-3.5" /></button> : null}</div>)}</div></section>
        </div>
      </div>
    </div>
  );
}
