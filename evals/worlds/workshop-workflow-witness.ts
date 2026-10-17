import { artifactDigest } from "../../ee/apps/den-api/src/workflow-artifacts.ts";
import type { JsonRecord, ObserverSnapshot, ObservedServiceCall, WorkflowWitness, SharingWitness } from "./workshop-narrative-contract.ts";

const obj = (value: unknown): JsonRecord => value !== null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
const arr = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const str = (value: unknown): string => typeof value === "string" ? value : "";
function parse(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { /* Some native MCP text envelopes concatenate JSON documents. */ }
  const documents: unknown[] = [];
  let start = 0;
  while (start < value.length) {
    while (/\s/.test(value[start] ?? "") && start < value.length) start++;
    if (start === value.length) return documents;
    if (!["{", "["].includes(value[start])) return value;
    let depth = 0, quoted = false, escaped = false, end = start;
    for (; end < value.length; end++) {
      const char = value[end];
      if (quoted) { if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === '"') quoted = false; continue; }
      if (char === '"') quoted = true;
      else if (char === "{" || char === "[") depth++;
      else if (char === "}" || char === "]") { depth--; if (depth === 0) { end++; break; } }
    }
    if (depth !== 0 || quoted) return value;
    try { documents.push(JSON.parse(value.slice(start, end))); } catch { return value; }
    start = end;
  }
  return documents.length ? documents : value;
}
/** Only backend response envelopes are decoded. Never inspect code/stdout as proof of calls. */
function records(value: unknown): JsonRecord[] {
  const decoded = parse(value);
  if (Array.isArray(decoded)) return decoded.flatMap(records);
  if (decoded === null || typeof decoded !== "object") return [];
  const row = obj(decoded);
  return [row, ...Object.entries(row).filter(([key]) => !["code", "stdout", "script", "logs"].includes(key)).flatMap(([, child]) => records(child))];
}
const time = (value: unknown): number => typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
const matches = (name: unknown, operation: string) => new RegExp(`(?:^|[:._])${operation}$`).test(str(name));
const sourceText = (value: unknown): string => (typeof value === "string" ? value : str(obj(value).value))
  .replace(/^[ \t]*(?:={2,}|-{2,})[ \t]*\r?$/gm, "").replace(/<[^>]*>/g, " ")
  .replace(/&(?:nbsp|#160);/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
  .replace(/[|#*_`]/g, " ").replace(/(?:^|\s)-+(?=\s|$)/g, " ").replace(/\s+/g, " ").trim();

export const WORKSHOP_WORKFLOW_INPUTS = Object.freeze({
  test: Object.freeze({ customerRequest: "Compare Atlas 2 and Atlas Lift for warehouse picking" }),
  rerun: Object.freeze({ customerRequest: "Compare Atlas Lift for cold-storage pallet moves" }),
  recipient: Object.freeze({ customerRequest: "Compare Atlas 2 for line-side replenishment" }),
});
export interface NativeWorkflowRead { status: number; body: unknown }
export interface NativeWorkflowObservation {
  list: unknown; details: unknown; grants: unknown; snapshots: unknown; runs: JsonRecord[];
  ownerMemberId: string; recipientMemberId: string;
  /** Native UI sharing grants the containing Plugin, not necessarily the config object. */
  pluginGrants?: { pluginId: string; access: unknown }[];
  boundary?: {
    recipientDetail?: NativeWorkflowRead;
    outsiderMemberId: string;
    outsiderList?: NativeWorkflowRead;
    outsiderDetail?: NativeWorkflowRead;
    outsiderSnapshots?: NativeWorkflowRead;
  };
}
export interface WorkflowActorEvidence {
  before: ObserverSnapshot; after: ObserverSnapshot;
  expected: { providerID: string; modelID: string; sessionId: string; agent?: string };
  /** Independent inference-proxy observations sliced to this actor's submitted turn(s), excluding preflight. */
  inference?: { upstreamModel: string; requests: readonly { upstreamModel: string; status: string; httpStatus: number | null }[] };
}
export interface WorkflowWitnessContext { owner?: WorkflowActorEvidence; recipient?: WorkflowActorEvidence }
export interface VerifiedWorkflowWitness extends WorkflowWitness {
  /** Exact verified authoring output, retained privately so its digest can be recomputed. */
  authoringResultValue: unknown;
  verification: {
    inputEvidence: "owned-db-canonical-digest";
    testExecutionType: "authoring-test"; rerunExecutionType: "saved-version";
    testCodeDigest: string; rerunCodeDigest: string;
    testInputDigest: string; rerunInputDigest: string;
    testResultDigest: string; rerunResultDigest: string;
    ownerSessionId: string; providerID: string; modelID: string; upstreamModel: string;
    executionEngine: "deterministic-codemode";
    sourcePageIds: string[];
  };
}
export interface VerifiedSharingWitness extends SharingWitness {
  verification: {
    grantScope: "workflow" | "plugin"; grantedResourceId: string;
    /** A Plugin grant is not represented as a single-Workflow grant. */
    visibleWorkflowIdsInGrantedPlugin: string[];
    input: { customerRequest: string }; inputEvidence: "owned-db-canonical-digest";
    recipientSessionId: string; providerID: string; modelID: string; upstreamModel: string;
    executionEngine: "deterministic-codemode";
    outsiderMemberId: string; outsiderListStatus: number; outsiderDetailStatus: number; outsiderSnapshotsStatus: number;
    sourcePageIds: string[];
  };
}
function savedWorkflow(after: NativeWorkflowObservation) {
  const item = arr(obj(after.list).items).map(obj).find((row) => row.title === "Acme product comparison" && str(row.configObjectId) && str(row.configObjectVersionId) && str(row.pluginId));
  if (!item) return undefined;
  const version = records(obj(after.details).script).find((row) => row.id === item.configObjectVersionId && str(row.codeDigest));
  if (!version) return undefined;
  return { item, version, workflowId: str(item.configObjectId), versionId: str(item.configObjectVersionId), pluginId: str(item.pluginId) };
}
function freshRuns(before: NativeWorkflowObservation, after: NativeWorkflowObservation): JsonRecord[] {
  return after.runs.filter((row) => str(row.id) && !before.runs.some((old) => old.id === row.id));
}
function sameVersion(row: JsonRecord, version: JsonRecord): boolean {
  return row.code_digest === version.codeDigest && row.input_schema_digest === version.inputSchemaDigest && row.output_schema_digest === version.outputSchemaDigest;
}
/** Bind the durable receipt to an actual completed tool in this actor's real-model session.
 * Session metadata proves model provenance; it does not assert a second inference happened inside the deterministic Workflow. */
function executionTool(row: JsonRecord, actor: WorkflowActorEvidence | undefined) {
  if (!actor || !str(actor.expected.sessionId) || !str(actor.expected.providerID) || !str(actor.expected.modelID)) return undefined;
  const inference = actor.inference;
  if (!inference || !str(inference.upstreamModel) || !inference.requests.some((request) => request.status === "completed" && request.httpStatus === 200) || inference.requests.some((request) => request.upstreamModel !== inference.upstreamModel || ["rejected", "upstream-error", "interrupted", "started"].includes(request.status))) return undefined;
  const previousIds = new Set(arr(actor.before.messages).map((message) => obj(obj(message).info).id));
  const messages = arr(actor.after.messages).map(obj).filter((message) => !previousIds.has(obj(message.info).id));
  const assistants = messages.filter((message) => obj(message.info).role === "assistant");
  if (!assistants.length || !assistants.every((message) => {
    const info = obj(message.info);
    return !info.error && info.providerID === actor.expected.providerID && info.modelID === actor.expected.modelID && info.sessionID === actor.expected.sessionId && info.agent === (actor.expected.agent ?? "openwork");
  })) return undefined;
  const last = obj(assistants.at(-1)?.info);
  if (last.finish !== "stop" || typeof obj(last.time).completed !== "number") return undefined;
  const candidates = assistants.flatMap((message) => arr(message.parts).map(obj)).filter((part) => {
    const state = obj(part.state), window = obj(state.time);
    return part.type === "tool" && str(part.callID) && state.status === "completed" && typeof window.start === "number" && typeof window.end === "number" && time(row.started_at) >= window.start && time(row.finished_at) <= window.end && records(state.output).some((record) => record.receiptId === row.id);
  });
  return candidates.length === 1 ? candidates[0] : undefined;
}
function sourcePages(row: JsonRecord, actor: WorkflowActorEvidence | undefined): JsonRecord[] | undefined {
  if (!actor || !records(row.tool_calls).some((call) => matches(call.name, "confluence_get_page"))) return undefined;
  const pages = arr(obj(obj(actor.after.atlassian).confluence).pages).map(obj).filter((page) => /datasheet/i.test(str(page.title)) && /Atlas (?:2|Lift)/.test(str(page.title)));
  if (pages.length !== 2 || pages.some((page) => !str(page.id) || !sourceText(page.body))) return undefined;
  const old = records(obj(actor.before.atlassian).audit);
  const reads = arr(obj(actor.after.atlassian).audit).map(obj).filter((entry) => entry.status === "completed" && matches(entry.name, "confluence_get_page") && typeof entry.at === "number" && entry.at >= time(row.started_at) && entry.at <= time(row.finished_at) && !old.some((prior) => prior.sequence !== undefined && prior.sequence === entry.sequence));
  if (!pages.every((page) => reads.some((entry) => records(entry.output).some((output) => {
    const body = obj(obj(output.body).storage).value ?? obj(output.body).value ?? output.content ?? output.body;
    return String(output.id ?? output.page_id ?? "") === page.id && sourceText(body) === sourceText(page.body);
  })))) return undefined;
  return pages;
}
/** Check source facts and input-specific use cases, not just successful execution or an echoed request. */
export function workflowComparisonSemantics(value: unknown, request: "test" | "rerun" | "recipient", pages: JsonRecord[]): boolean {
  const output = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  if (!pages.every((page) => output.includes(str(page.id)))) return false;
  const excluded = new Set(["customerrequest", "request", "input", "sources", "rawsources", "sourcepages", "sourcetext", "datasheets"]);
  const assessment = (item: unknown): unknown => {
    const decoded = parse(item);
    if (Array.isArray(decoded)) return decoded.map(assessment);
    if (decoded !== null && typeof decoded === "object") return Object.fromEntries(Object.entries(obj(decoded)).filter(([key]) => !excluded.has(key.replace(/[_-]/g, "").toLowerCase())).map(([key, child]) => [key, assessment(child)]));
    if (typeof decoded !== "string") return decoded;
    return Object.values(WORKSHOP_WORKFLOW_INPUTS).reduce((text, input) => text.replaceAll(input.customerRequest, ""), decoded);
  };
  const assessed = assessment(value);
  const compared = JSON.stringify(assessed) ?? "";
  if (!/Atlas\s*2/i.test(compared) || !/Atlas\s*Lift/i.test(compared) || !/\b300\s*(?:kg|kilogram)/i.test(compared) || !/\b1[,. ]?200\s*(?:kg|kilogram)/i.test(compared)) return false;
  // These three requests name published use cases. Missing site parameters may
  // qualify deployment, but cannot erase the documented use-case match.
  const target = request === "rerun" ? "lift" : "2";
  const productName = (item: unknown) => /^Atlas\s*(2|Lift)$/i.exec(str(item))?.[1].toLowerCase() ?? "";
  const contradictsMatch = (item: unknown, scope = ""): boolean => {
    if (Array.isArray(item)) return item.some((child) => contradictsMatch(child, scope));
    if (item !== null && typeof item === "object") {
      const row = obj(item);
      const local = Object.values(row).map(productName).find(Boolean) ?? scope;
      return Object.entries(row).some(([key, child]) => contradictsMatch(child, productName(key) || local));
    }
    if (typeof item !== "string" || (scope && scope !== target)) return false;
    return item.split(/[.!?\n]/).some((sentence) => {
      if (!/no documented (?:match|use.case)|(?:use.case|line.side).{0,50}not documented/i.test(sentence)) return false;
      const names = [...sentence.matchAll(/Atlas\s*(2|Lift)/gi)].map((match) => match[1].toLowerCase());
      return names.length === 0 || names.includes(target);
    });
  };
  if (contradictsMatch(assessed)) return false;
  if (request === "test") return /warehouse|goods.to.person/i.test(compared) && /pick/i.test(compared);
  if (request === "recipient") return /(?:Atlas\s*2[^.!?\n]{0,300}line.side[^.!?\n]{0,60}replenish|line.side[^.!?\n]{0,60}replenish[^.!?\n]{0,300}Atlas\s*2)/i.test(compared);
  return /cold.storage/i.test(compared) && /pallet/i.test(compared) && /[-−]25\s*(?:°\s*)?C\b/i.test(compared) && /optional|kit/i.test(compared);
}
function savedRunEvidence(row: JsonRecord, saved: NonNullable<ReturnType<typeof savedWorkflow>>, after: NativeWorkflowObservation, actor: WorkflowActorEvidence | undefined, identity: "owner" | "recipient", request: "rerun" | "recipient") {
  if (row.status !== "succeeded" || row.org_membership_id !== (identity === "owner" ? after.ownerMemberId : after.recipientMemberId) || row.config_object_id !== saved.workflowId || row.config_object_version_id !== saved.versionId || row.plugin_id !== saved.pluginId || row.source !== `plugin:${saved.pluginId}:${saved.workflowId}` || !sameVersion(row, saved.version) || row.script_input_digest !== artifactDigest(WORKSHOP_WORKFLOW_INPUTS[request])) return undefined;
  const tool = executionTool(row, actor), pages = sourcePages(row, actor);
  if (!tool || !pages) return undefined;
  const snapshot = records(obj(after.snapshots)[identity]).find((snapshot) => snapshot.receiptId === row.id && snapshot.configObjectId === saved.workflowId && snapshot.configObjectVersionId === saved.versionId && snapshot.status === "succeeded" && snapshot.codeDigest === saved.version.codeDigest && snapshot.contentDeletedAt == null && snapshot.value !== undefined && snapshot.value !== null);
  if (!snapshot || artifactDigest(snapshot.value) !== row.result_digest || !workflowComparisonSemantics(snapshot.value, request, pages)) return undefined;
  return { tool, pages, snapshot };
}

/** Normalize real saved executions hidden inside Code Mode. The name/receipt
 * come from the native DB, never script text or stdout. Each call still needs
 * the caller's completed tool window, actual returned receipt, exact actor,
 * saved code/schema/input/output digests, full source reads and saved output. */
export function observedNativeWorkflowCalls(before: NativeWorkflowObservation, after: NativeWorkflowObservation, context: WorkflowWitnessContext): ObservedServiceCall[] {
  const saved = savedWorkflow(after);
  if (!saved) return [];
  const result: ObservedServiceCall[] = [];
  for (const [identity, request, actor] of [["owner", "rerun", context.owner], ["recipient", "recipient", context.recipient]] satisfies ["owner" | "recipient", "rerun" | "recipient", WorkflowActorEvidence | undefined][]) {
    for (const row of freshRuns(before, after)) {
      const evidence = savedRunEvidence(row, saved, after, actor, identity, request);
      if (!evidence) continue;
      result.push({ callId: str(evidence.tool.callID), name: str(row.source), input: { canonicalInputDigest: row.script_input_digest }, output: { receiptId: row.id, configObjectId: row.config_object_id, configObjectVersionId: row.config_object_version_id, resultDigest: row.result_digest }, status: "completed", service: "den" });
    }
  }
  return result;
}

/** Exact input objects are corroborated by Den's canonical digest; raw caller inputs are deliberately not retained.
 * A digest match is a cryptographic equality check, not a claim that script_input was decoded from the DB. */
export function workflowWitness(before: NativeWorkflowObservation, after: NativeWorkflowObservation, context: WorkflowWitnessContext = {}): VerifiedWorkflowWitness | undefined {
  const saved = savedWorkflow(after);
  if (!saved || !str(after.ownerMemberId)) return undefined;
  const fresh = freshRuns(before, after);
  const test = fresh.find((row) => row.status === "succeeded" && !row.config_object_id && !row.config_object_version_id && row.source === "adhoc" && sameVersion(row, saved.version) && row.org_membership_id === after.ownerMemberId && row.script_input_digest === artifactDigest(WORKSHOP_WORKFLOW_INPUTS.test));
  const latest = obj(obj(obj(after.details).script).latestSnapshot);
  const rerun = fresh.find((row) => row.id === latest.receiptId && savedRunEvidence(row, saved, after, context.owner, "owner", "rerun"));
  if (!test || !rerun || test.id === rerun.id || test.result_digest === rerun.result_digest) return undefined;
  if (latest.receiptId !== rerun.id || latest.value === undefined || artifactDigest(latest.value) !== rerun.result_digest) return undefined;
  const tool = executionTool(test, context.owner), pages = sourcePages(test, context.owner);
  if (!tool || !pages) return undefined;
  const outputs = records(obj(tool.state).output);
  const metadata = outputs.find((output) => obj(output.metadata).receiptId === test.id && obj(output.metadata).executionType === "authoring-test" && obj(obj(output.metadata).retention).available === true && obj(obj(output.metadata).retention).canSaveByReceipt === true);
  const wrapped = outputs.find((output) => output.value !== undefined && artifactDigest(output.value) === test.result_digest);
  // The native MCP response may put value and metadata in separate text parts.
  const textPart = outputs.find((output) => output.type === "text" && typeof output.text === "string" && artifactDigest(output.text) === test.result_digest);
  const value = wrapped ? wrapped.value : textPart ? textPart.text : outputs.find((output) => artifactDigest(output) === test.result_digest);
  if (!metadata || value === undefined || !workflowComparisonSemantics(value, "test", pages)) return undefined;
  return { workflowId: saved.workflowId, versionId: saved.versionId, savedNativeWorkflow: true, observedViaDenGet: true, authoringResultValue: value,
    test: { receiptId: str(test.id), workflowId: saved.workflowId, versionId: saved.versionId, status: "succeeded", input: { ...WORKSHOP_WORKFLOW_INPUTS.test } },
    rerun: { receiptId: str(rerun.id), workflowId: saved.workflowId, versionId: saved.versionId, status: "succeeded", input: { ...WORKSHOP_WORKFLOW_INPUTS.rerun } },
    verification: { inputEvidence: "owned-db-canonical-digest", testExecutionType: "authoring-test", rerunExecutionType: "saved-version", testCodeDigest: str(test.code_digest), rerunCodeDigest: str(rerun.code_digest), testInputDigest: str(test.script_input_digest), rerunInputDigest: str(rerun.script_input_digest), testResultDigest: str(test.result_digest), rerunResultDigest: str(rerun.result_digest), ownerSessionId: context.owner!.expected.sessionId, providerID: context.owner!.expected.providerID, modelID: context.owner!.expected.modelID, upstreamModel: context.owner!.inference!.upstreamModel, executionEngine: "deterministic-codemode", sourcePageIds: pages.map((page) => str(page.id)) } };
}
interface GrantCandidate { row: JsonRecord; scope: "workflow" | "plugin"; resourceId: string }
function grantCandidates(observation: NativeWorkflowObservation, saved: NonNullable<ReturnType<typeof savedWorkflow>>): GrantCandidate[] {
  const direct = records(observation.grants).filter((row) => str(row.id)).map<GrantCandidate>((row) => ({ row, scope: "workflow", resourceId: saved.workflowId }));
  const inherited = (observation.pluginGrants ?? []).filter((grant) => grant.pluginId === saved.pluginId).flatMap((grant) => records(grant.access).filter((row) => str(row.id)).map<GrantCandidate>((row) => ({ row, scope: "plugin", resourceId: grant.pluginId })));
  // serializeAccessGrant intentionally omits resource IDs: bind them to the GET endpoint's envelope.
  return [...direct, ...inherited].filter(({ row, scope, resourceId }) => !row.removedAt && (scope === "workflow" ? row.configObjectId === undefined || row.configObjectId === resourceId : row.pluginId === undefined || row.pluginId === resourceId));
}
function denied(read: NativeWorkflowRead | undefined): boolean { return read !== undefined && [403, 404].includes(read.status); }
export function sharingWitness(before: NativeWorkflowObservation, after: NativeWorkflowObservation, context: WorkflowWitnessContext = {}): VerifiedSharingWitness | undefined {
  const saved = savedWorkflow(after), boundary = after.boundary;
  if (!saved || !context.recipient || !str(after.ownerMemberId) || !str(after.recipientMemberId) || after.ownerMemberId === after.recipientMemberId || !boundary || !str(boundary.outsiderMemberId) || [after.ownerMemberId, after.recipientMemberId].includes(boundary.outsiderMemberId)) return undefined;
  const recipient = boundary.recipientDetail, outsider = boundary.outsiderList;
  const recipientScript = obj(obj(recipient?.body).script);
  if (recipient?.status !== 200 || recipientScript.canManage !== false || recipientScript.configObjectId !== saved.workflowId || !records(recipientScript).some((row) => row.id === saved.versionId) || outsider?.status !== 200 || !Array.isArray(obj(outsider.body).items) || records(outsider.body).some((row) => row.configObjectId === saved.workflowId) || !denied(boundary.outsiderDetail) || !denied(boundary.outsiderSnapshots)) return undefined;
  const candidates = grantCandidates(after, saved), old = grantCandidates(before, saved);
  // A targeted viewer receipt is insufficient if another grant made the recipient a manager or everyone a viewer.
  if (candidates.some(({ row }) => row.orgWide === true || (row.orgMembershipId === after.recipientMemberId && row.role !== "viewer"))) return undefined;
  const grant = candidates.find(({ row }) => row.orgMembershipId === after.recipientMemberId && row.role === "viewer" && !row.orgWide && !row.teamId && !old.some((prior) => prior.row.id === row.id));
  const latest = obj(recipientScript.latestSnapshot);
  const execution = freshRuns(before, after).find((row) => row.id === latest.receiptId && savedRunEvidence(row, saved, after, context.recipient, "recipient", "recipient"));
  if (!grant || !execution) return undefined;
  if (latest.receiptId !== execution.id || latest.value === undefined || artifactDigest(latest.value) !== execution.result_digest) return undefined;
  const pages = sourcePages(execution, context.recipient);
  if (!pages) return undefined;
  return { workflowId: saved.workflowId, versionId: saved.versionId, grantId: str(grant.row.id), role: "viewer", recipientEmail: "nora@acme.test", ownerMemberId: after.ownerMemberId, recipientMemberId: after.recipientMemberId, executionMemberId: str(execution.org_membership_id), receiptId: str(execution.id), status: "succeeded", observedViaDenGet: true,
    verification: { grantScope: grant.scope, grantedResourceId: grant.resourceId, visibleWorkflowIdsInGrantedPlugin: grant.scope === "plugin" ? arr(obj(after.list).items).map(obj).filter((row) => row.pluginId === saved.pluginId).map((row) => str(row.configObjectId)).filter(Boolean) : [saved.workflowId], input: { ...WORKSHOP_WORKFLOW_INPUTS.recipient }, inputEvidence: "owned-db-canonical-digest", recipientSessionId: context.recipient.expected.sessionId, providerID: context.recipient.expected.providerID, modelID: context.recipient.expected.modelID, upstreamModel: context.recipient.inference!.upstreamModel, executionEngine: "deterministic-codemode", outsiderMemberId: boundary.outsiderMemberId, outsiderListStatus: outsider.status, outsiderDetailStatus: boundary.outsiderDetail!.status, outsiderSnapshotsStatus: boundary.outsiderSnapshots!.status, sourcePageIds: pages.map((page) => str(page.id)) } };
}
