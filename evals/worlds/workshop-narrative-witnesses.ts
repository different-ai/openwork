import type { ObserverSnapshot, ObservedServiceCall, WorkflowWitness, SharingWitness, JsonRecord } from "./workshop-narrative-contract.ts";
const obj = (value: unknown): JsonRecord => value !== null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
const arr = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const str = (value: unknown) => typeof value === "string" ? value : "";

/** Bind only actual server-side MCP observations to a unique completed Code Mode tool's real time window. */
export function observedServiceCalls(before: ObserverSnapshot, after: ObserverSnapshot): ObservedServiceCall[] {
  const tools = arr(after.messages).flatMap((message) => arr(obj(message).parts).map(obj)).filter((part) => part.type === "tool" && obj(part.state).status === "completed");
  const result: ObservedServiceCall[] = [];
  for (const [key, service] of [["atlassian", "atlassian"], ["microsoft", "microsoft"], ["news", "news"]] as const) {
    const old = arr(obj(before[key]).audit).map(obj);
    for (const entry of arr(obj(after[key]).audit).map(obj)) {
      if (old.some((value) => value.sequence === entry.sequence)) continue;
      const candidates = tools.filter((tool) => {
        const state = obj(tool.state), time = obj(state.time), input = obj(state.input);
        return (typeof input.code === "string" || /execute_capability_script/.test(str(tool.tool))) && typeof time.start === "number" && typeof time.end === "number" && typeof entry.at === "number" && entry.at >= time.start && entry.at <= time.end;
      });
      if (candidates.length !== 1 || !str(candidates[0].callID)) continue;
      result.push({ callId: str(candidates[0].callID), name: str(entry.name), input: entry.input, output: entry.output, status: entry.status === "completed" ? "completed" : "error", service });
    }
  }
  return result;
}

export interface NativeWorkflowObservation {
  list: unknown; details: unknown; grants: unknown; snapshots: unknown; runs: JsonRecord[];
  ownerMemberId: string; recipientMemberId: string;
}
const records = (value: unknown): JsonRecord[] => Array.isArray(value) ? value.flatMap(records) : value !== null && typeof value === "object" ? [obj(value), ...Object.values(obj(value)).flatMap(records)] : [];

/** Workflow snapshots are read through Den, with caller/input digests independently corroborated in the owned DB. */
export function workflowWitness(before: NativeWorkflowObservation, after: NativeWorkflowObservation): WorkflowWitness | undefined {
  const item = records(after.list).find((row) => row.title === "Acme product comparison" && typeof row.configObjectId === "string");
  if (!item) return undefined;
  const workflowId = str(item.configObjectId), versionId = str(item.configObjectVersionId);
  const version = records(after.details).find((row) => row.id === versionId && typeof row.codeDigest === "string");
  const fresh = after.runs.filter((row) => !before.runs.some((old) => old.id === row.id));
  const test = fresh.find((row) => row.status === "succeeded" && !row.config_object_id && row.code_digest === version?.codeDigest && row.org_membership_id === after.ownerMemberId);
  const rerun = fresh.find((row) => row.status === "succeeded" && row.config_object_id === workflowId && row.config_object_version_id === versionId && row.org_membership_id === after.ownerMemberId && records(after.snapshots).some((snapshot) => snapshot.receiptId === row.id));
  if (!test || !rerun || !versionId) return undefined;
  return { workflowId, versionId, savedNativeWorkflow: true, observedViaDenGet: true,
    test: { receiptId: str(test.id), workflowId, versionId, status: str(test.status), input: { actualInputDigest: test.script_input_digest } },
    rerun: { receiptId: str(rerun.id), workflowId, versionId, status: str(rerun.status), input: { actualInputDigest: rerun.script_input_digest } } };
}
export function sharingWitness(before: NativeWorkflowObservation, after: NativeWorkflowObservation): SharingWitness | undefined {
  const item = records(after.list).find((row) => row.title === "Acme product comparison" && typeof row.configObjectId === "string");
  if (!item) return undefined;
  const grant = records(after.grants).find((row) => row.orgMembershipId === after.recipientMemberId && row.role === "viewer" && !records(before.grants).some((old) => old.id && old.id === row.id));
  const execution = after.runs.find((row) => !before.runs.some((old) => old.id === row.id) && row.config_object_id === item.configObjectId && row.config_object_version_id === item.configObjectVersionId && row.org_membership_id === after.recipientMemberId && row.status === "succeeded" && records(after.snapshots).some((snapshot) => snapshot.receiptId === row.id));
  if (!grant || !execution || !str(grant.id)) return undefined;
  return { workflowId: str(item.configObjectId), versionId: str(item.configObjectVersionId), grantId: str(grant.id), role: "viewer", recipientEmail: "nora@acme.test", ownerMemberId: after.ownerMemberId, recipientMemberId: after.recipientMemberId, executionMemberId: str(execution.org_membership_id), receiptId: str(execution.id), status: "succeeded", observedViaDenGet: true };
}
