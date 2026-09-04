"use client";

import { useEffect, useMemo, useState } from "react";
import type { WorkflowArtifactSnapshot, WorkflowDetail, WorkflowTestResult } from "@openwork/types/workflows";
import { formFieldsFromSchema } from "./workflow-input-form";
import {
  useDeleteWorkflowSnapshot,
  useRunWorkflow,
  useSaveWorkflowVersion,
  useTestWorkflow,
  useUpdateWorkflowAutomation,
  useWorkflowSnapshots,
  type WorkflowDraft,
} from "./workflow-data";
import {
  useActivateArtifactView,
  useRetireArtifactView,
  useWorkflowLibraryDetail,
} from "./workflow-detail-data";

export type WorkflowFields = {
  name: string;
  description: string;
  code: string;
  input: string;
  inputSchema: string;
  outputSchema: string;
};

function pretty(value: unknown) {
  return value === null || value === undefined ? "" : JSON.stringify(value, null, 2);
}

function initialFields(detail: WorkflowDetail): WorkflowFields {
  return {
    name: detail.title,
    description: detail.description ?? "",
    code: detail.currentVersion.code ?? "",
    input: pretty(detail.currentVersion.exampleInput ?? {}),
    inputSchema: pretty(detail.currentVersion.inputSchema),
    outputSchema: pretty(detail.currentVersion.outputSchema),
  };
}

function parseJson(label: string, value: string, optional = false): unknown {
  if (!value.trim() && optional) return undefined;
  try {
    return JSON.parse(value.trim() || "null");
  } catch {
    throw new Error(`${label}: check the format and try again.`);
  }
}

export function parseWorkflowJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function isWorkflowObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function workflowFormValue(value: string): Record<string, unknown> {
  const parsed = parseWorkflowJson(value);
  return isWorkflowObject(parsed) ? parsed : {};
}

export function workflowDiagramInput(
  snapshot: WorkflowArtifactSnapshot | null,
  exampleInput: unknown,
): Record<string, unknown> | undefined {
  if (snapshot && "input" in snapshot && isWorkflowObject(snapshot.input)) return snapshot.input;
  return isWorkflowObject(exampleInput) ? exampleInput : undefined;
}

function toDraft(detail: WorkflowDetail, fields: WorkflowFields): WorkflowDraft {
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

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "That action did not work. Please try again.";
}

export function useWorkflowDetailState(configObjectId: string) {
  const detailQuery = useWorkflowLibraryDetail(configObjectId);
  const snapshotsQuery = useWorkflowSnapshots(configObjectId);
  const testMutation = useTestWorkflow(configObjectId);
  const saveMutation = useSaveWorkflowVersion(configObjectId);
  const runMutation = useRunWorkflow(configObjectId);
  const deleteMutation = useDeleteWorkflowSnapshot(configObjectId);
  const updateAutomationMutation = useUpdateWorkflowAutomation(configObjectId);
  const activateViewMutation = useActivateArtifactView(configObjectId);
  const retireViewMutation = useRetireArtifactView(configObjectId);
  const [fields, setFields] = useState<WorkflowFields | null>(null);
  const [base, setBase] = useState("");
  const [tested, setTested] = useState<{ result: WorkflowTestResult; fingerprint: string } | null>(null);
  const [selectedReceiptId, setSelectedReceiptId] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [loadedVersion, setLoadedVersion] = useState<string | null>(null);
  const [showJsonInput, setShowJsonInput] = useState(false);
  const [technical, setTechnical] = useState(false);
  const libraryDetail = detailQuery.data;
  const detail = libraryDetail?.script;
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
  const selectedSnapshot = snapshots.find((snapshot) => snapshot.receiptId === selectedReceiptId)
    ?? detail?.latestSnapshot
    ?? detail?.latestSuccessfulSnapshot
    ?? null;
  const pending = testMutation.isPending
    || saveMutation.isPending
    || runMutation.isPending
    || deleteMutation.isPending
    || updateAutomationMutation.isPending;
  const viewPending = activateViewMutation.isPending || retireViewMutation.isPending;
  const firstError = [
    testMutation.error,
    saveMutation.error,
    runMutation.error,
    deleteMutation.error,
    updateAutomationMutation.error,
    activateViewMutation.error,
    retireViewMutation.error,
    detailQuery.error,
    snapshotsQuery.error,
  ].find((value) => value !== null && value !== undefined);
  const error = localError ?? (firstError ? errorMessage(firstError) : null);
  const currentAutomationCount = useMemo(
    () => detail?.versions.reduce((sum, version) => sum + version.automationReferences.length, 0) ?? 0,
    [detail],
  );
  const parsedInputSchema = detail && fields
    ? detail.canManage
      ? parseWorkflowJson(fields.inputSchema)
      : detail.currentVersion.inputSchema
    : null;
  const hasInputForm = formFieldsFromSchema(parsedInputSchema) !== null;
  const inputFormValue = fields ? workflowFormValue(fields.input) : {};

  function update(key: keyof WorkflowFields, value: string) {
    setFields((current) => current ? { ...current, [key]: value } : current);
    setTested(null);
    setLocalError(null);
  }

  function runNow() {
    if (!detail || !fields) return;
    setLocalError(null);
    try {
      const input = parseJson("Run details", fields.input);
      void runMutation.mutateAsync({
        pluginId: detail.pluginId,
        configObjectVersionId: detail.currentVersion.id,
        input,
      }).catch((reason) => setLocalError(errorMessage(reason)));
    } catch (reason) {
      setLocalError(errorMessage(reason));
    }
  }

  function testChanges() {
    if (!detail || !fields) return;
    setLocalError(null);
    try {
      const draft = toDraft(detail, fields);
      void testMutation.mutateAsync(draft)
        .then((result) => setTested({ result, fingerprint }))
        .catch((reason) => setLocalError(errorMessage(reason)));
    } catch (reason) {
      setLocalError(errorMessage(reason));
    }
  }

  function saveNewVersion() {
    if (!detail || !fields || !tested) return;
    setLocalError(null);
    try {
      const draft = toDraft(detail, fields);
      void saveMutation.mutateAsync({ receiptId: tested.result.receiptId, draft })
        .catch((reason) => setLocalError(errorMessage(reason)));
    } catch (reason) {
      setLocalError(errorMessage(reason));
    }
  }

  function deleteSnapshot(receiptId: string) {
    setLocalError(null);
    void deleteMutation.mutateAsync(receiptId).catch((reason) => setLocalError(errorMessage(reason)));
  }

  function updateAutomation(input: {
    automationId: string;
    pluginId: string;
    configObjectVersionId: string;
    input: unknown;
  }) {
    setLocalError(null);
    void updateAutomationMutation.mutateAsync(input).catch((reason) => setLocalError(errorMessage(reason)));
  }

  function activateView(viewId: string, revisionId: string) {
    setLocalError(null);
    void activateViewMutation.mutateAsync({ viewId, revisionId }).catch((reason) => setLocalError(errorMessage(reason)));
  }

  function retireView(viewId: string) {
    setLocalError(null);
    void retireViewMutation.mutateAsync(viewId).catch((reason) => setLocalError(errorMessage(reason)));
  }

  function close(onClose: () => void) {
    if (dirty && !window.confirm("Discard your unsaved changes?")) return;
    onClose();
  }

  return {
    libraryDetail,
    detail,
    views: libraryDetail?.views ?? [],
    fields,
    snapshots,
    selectedSnapshot,
    selectedReceiptId,
    tested,
    fingerprint,
    dirty,
    technical,
    showJsonInput,
    parsedInputSchema,
    hasInputForm,
    inputFormValue,
    currentAutomationCount,
    pending,
    viewPending,
    error,
    loading: detailQuery.isLoading || !libraryDetail || !detail || !fields,
    setTechnical,
    setShowJsonInput,
    setSelectedReceiptId,
    update,
    runNow,
    testChanges,
    saveNewVersion,
    deleteSnapshot,
    updateAutomation,
    activateView,
    retireView,
    close,
  };
}
