import {
  CONFIG_BLOB_MAX_BYTES,
  configBlobSchema,
  type ConfigApplyItemStatus,
  type ConfigApplyReport,
  type ConfigApplyReportItem,
  type ConfigApplyRunStatus,
  type ConfigApplyStep,
  type ConfigAreaDescriptor,
  type ConfigAreaKey,
  type ConfigBlob,
  type ConfigBlobSource,
  type ConfigChangeRequestStatus,
  type ConfigChangeRequestSummary,
  type ConfigDecisions,
  type ConfigFieldChange,
  type ConfigMatchTier,
  type ConfigPlan,
  type ConfigPlanItem,
  type ConfigPlanOp,
  type ConfigPlanRef,
  type ConfigPlanSummary,
  parseConfigRef,
} from "@openwork/types/den/config-blobs";
import type { DenChipTone } from "../../../_components/ui/chip";

/** Statuses the worker moves on its own; the page polls while a request sits in one. */
export const CONFIG_TRANSIENT_STATUSES: readonly ConfigChangeRequestStatus[] = ["uploaded", "analyzing", "queued", "applying", "stale"];

export function isTransientStatus(status: ConfigChangeRequestStatus | null | undefined): boolean {
  return status ? CONFIG_TRANSIENT_STATUSES.includes(status) : false;
}

export const CONFIG_STATUS_PRESENTATION: Record<ConfigChangeRequestStatus, { label: string; tone: DenChipTone }> = {
  uploaded: { label: "Checking", tone: "neutral" },
  analyzing: { label: "Checking", tone: "neutral" },
  invalid: { label: "Couldn't read", tone: "danger" },
  needs_review: { label: "Needs review", tone: "warning" },
  approved: { label: "Approved", tone: "info" },
  queued: { label: "Waiting to apply", tone: "info" },
  applying: { label: "Applying", tone: "info" },
  applied: { label: "Applied", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  stale: { label: "Rechecking", tone: "neutral" },
  superseded: { label: "Replaced", tone: "neutral" },
  cancelled: { label: "Withdrawn", tone: "neutral" },
};

export const CONFIG_OP_LABELS: Record<ConfigPlanOp, string> = {
  create: "Add",
  update: "Change",
  rename: "Rename",
  unchanged: "No change",
  delete: "Remove",
  untouched: "Left as is",
  skip: "Skipped",
};

/** Review order: what changes first, what stays last. */
export const CONFIG_OP_ORDER: readonly ConfigPlanOp[] = ["delete", "create", "update", "rename", "skip", "untouched", "unchanged"];

const MATCH_TIER_LABELS: Record<ConfigMatchTier, string> = {
  id: "Same item",
  alias: "Same item, imported before",
  decision: "Matched earlier",
  key: "Matched by key",
  natural: "Matched by name",
  proposed: "Suggested match",
};

export function matchTierLabel(tier: ConfigMatchTier | null): string | null {
  return tier ? MATCH_TIER_LABELS[tier] : null;
}

export function formatSummaryCounts(summary: ConfigPlanSummary | null): { create: string; update: string; remove: string } | null {
  if (!summary) return null;
  return { create: `+${summary.create}`, update: `~${summary.update + summary.rename}`, remove: `−${summary.delete}` };
}

/**
 * Whether the current member can approve, mirroring den-api: one approval per
 * member and, with "Require a second approver" on, the second approver is
 * neither the uploader nor the first approver.
 */
export function approvalState(input: {
  approvals: ReadonlyArray<{ memberId: string }>;
  createdByMemberId: string | null;
  memberId: string | null;
  requireSecondApprover: boolean;
}): { needed: number; canApprove: boolean; reason: string | null } {
  const needed = input.requireSecondApprover ? 2 : 1;
  const mine = input.memberId !== null && input.approvals.some((approval) => approval.memberId === input.memberId);
  if (mine) return { needed, canApprove: false, reason: input.approvals.length < needed ? "You approved this. It needs a second approver." : null };
  if (input.requireSecondApprover && input.approvals.length >= 1 && input.memberId !== null && input.memberId === input.createdByMemberId) {
    return { needed, canApprove: false, reason: "Waiting for a second approver. It can't be you: you uploaded this change." };
  }
  return { needed, canApprove: true, reason: null };
}

export function formatScore(score: number): string {
  return `${Math.round(Math.max(0, Math.min(1, score)) * 100)}%`;
}

export function formatRelativeTime(iso: string | null, now = Date.now()): string {
  if (!iso) return "";
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return "";
  const minutes = Math.round((now - parsed) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return new Date(parsed).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** `openwork-config-<org-slug>-<YYYY-MM-DD>.json` */
export function configExportFileName(orgSlug: string | null | undefined, date = new Date(), suffix?: string): string {
  const slug = (orgSlug ?? "organization").replace(/[^a-z0-9-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "organization";
  const day = date.toISOString().slice(0, 10);
  return `openwork-config-${slug}-${suffix ? `${suffix}-` : ""}${day}.json`;
}

// ---------------------------------------------------------------------------
// Export tree

export type ConfigAreaGroup = {
  label: string;
  areas: ConfigAreaDescriptor[];
};

/** Groups areas by the first segment of their sidebar breadcrumb, keeping registry order. */
export function groupConfigAreas(areas: readonly ConfigAreaDescriptor[]): ConfigAreaGroup[] {
  const groups: ConfigAreaGroup[] = [];
  for (const area of areas) {
    const label = area.path[0] ?? area.label;
    const existing = groups.find((group) => group.label === label);
    if (existing) existing.areas.push(area);
    else groups.push({ label, areas: [area] });
  }
  return groups;
}

/** The label under its group: the rest of the breadcrumb, or the area label. */
export function areaLeafLabel(area: ConfigAreaDescriptor): string {
  return area.path.length > 1 ? area.path.slice(1).join(" › ") : area.label;
}

export function isExportable(area: ConfigAreaDescriptor): boolean {
  return area.supported && area.canExport;
}

/** `null` means the whole organization (no `areas` query). */
export function exportAreasParam(areas: readonly ConfigAreaDescriptor[], selected: ReadonlySet<ConfigAreaKey>): string | null {
  const exportable = areas.filter(isExportable);
  // The whole-org export leaves out what the caller can't view on its own.
  if (exportable.length > 0 && exportable.every((area) => selected.has(area.key))) return null;
  return exportable.filter((area) => selected.has(area.key)).map((area) => area.key).join(",");
}

/** `11 of 26 areas can be exported.`: what Export offers this person. */
export function exportOverview(areas: readonly ConfigAreaDescriptor[]): string {
  const exportable = areas.filter(isExportable).length;
  if (areas.length === 0) return "No areas can be exported on this OpenWork.";
  if (exportable === 0) return "You can't export any area. Ask an organization owner or admin.";
  if (exportable === areas.length) return `All ${areas.length} areas can be exported.`;
  return `${exportable} of ${areas.length} areas can be exported. The others need more access or aren't available here.`;
}

// ---------------------------------------------------------------------------
// Overview summaries of Changes and History

type ChangeRequestTitleFields = Pick<ConfigChangeRequestSummary, "title" | "source" | "revertsChangeRequestId" | "sourceOrganization">;

export function changeRequestTitle(request: ChangeRequestTitleFields): string {
  if (request.title) return request.title;
  if (request.source === "revert") return "Restore previous config";
  if (request.sourceOrganization) return `Import from ${request.sourceOrganization.name}`;
  return request.source === "api" ? "Import from the API" : "Import";
}

/** Open requests that wait on someone: a decision on the plan, or an approval. */
export function changesOverview(open: readonly ConfigChangeRequestSummary[], now = Date.now()): { headline: string; latest: string | null } {
  if (open.length === 0) return { headline: "No changes waiting.", latest: null };
  const toDecide = open.filter((request) => request.status === "needs_review" && (request.summary?.blocking ?? 0) > 0).length;
  const toApprove = open.filter((request) => request.status === "needs_review" && (request.summary?.blocking ?? 0) === 0).length;
  const unreadable = open.filter((request) => request.status === "invalid").length;
  const parts = [`${open.length} open`];
  if (toDecide > 0) parts.push(`${toDecide} ${toDecide === 1 ? "needs" : "need"} a decision`);
  if (toApprove > 0) parts.push(`${toApprove} ready to approve`);
  if (unreadable > 0) parts.push(`${unreadable} couldn't be read`);
  const newest = open.reduce((latest, request) => Date.parse(request.createdAt) > Date.parse(latest.createdAt) ? request : latest);
  const status = CONFIG_STATUS_PRESENTATION[newest.status].label.toLowerCase();
  return {
    headline: `${parts.join(", ")}.`,
    latest: `Latest: ${changeRequestTitle(newest)}, ${status}, uploaded ${formatRelativeTime(newest.createdAt, now)}.`,
  };
}

/** The last request that was applied or failed, with its date. */
export function historyOverview(closed: readonly ConfigChangeRequestSummary[], locale?: string): string {
  const finished = closed
    .filter((request) => request.status === "applied" || request.status === "failed")
    .map((request) => ({ request, at: request.appliedAt ?? request.updatedAt }))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
  if (!finished) return closed.length > 0 ? "Nothing applied yet. Withdrawn and replaced changes are listed here." : "Nothing applied yet.";
  const day = formatDay(finished.at, locale);
  const verb = finished.request.status === "applied" ? "Last applied" : "Last failed";
  return `${verb}: ${changeRequestTitle(finished.request)}${day ? ` on ${day}` : ""}.`;
}

// ---------------------------------------------------------------------------
// Import file

export type ImportFileCheck =
  | { ok: true; blob: ConfigBlob; areaCount: number; source: ConfigBlobSource | null; exportedAt: string | null }
  | { ok: false; message: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Client-side check before upload: size, JSON, and the file's outer shape. The server checks everything again. */
export function checkImportFile(text: string, byteSize: number): ImportFileCheck {
  if (byteSize > CONFIG_BLOB_MAX_BYTES) {
    return { ok: false, message: `This file is larger than ${Math.round(CONFIG_BLOB_MAX_BYTES / (1024 * 1024))} MB. Export fewer areas and try again.` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, message: "This file isn't valid JSON. Choose a file exported from OpenWork." };
  }
  if (!isPlainObject(parsed) || parsed.format !== "openwork.config-blob") {
    return { ok: false, message: "This isn't an OpenWork config file. Choose a file exported from Settings › Config." };
  }
  const result = configBlobSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue && issue.path.length > 0 ? ` (${issue.path.join(".")})` : "";
    return { ok: false, message: `This config file has a problem${where}: ${issue?.message ?? "unknown"}. Fix it or export it again.` };
  }
  const areas = result.data.areas;
  const blob: ConfigBlob = { ...result.data, areas: isAreasTree(areas) ? areas : {} };
  return { ok: true, blob, areaCount: result.data.scope.length, source: result.data.source ?? null, exportedAt: result.data.exportedAt ?? null };
}

function isAreasTree(value: Record<string, unknown>): value is ConfigBlob["areas"] {
  return Object.values(value).every(isPlainObject);
}

/** `Nov 9, 2026` in the reader's locale; empty when the date can't be read. */
export function formatDay(iso: string | null | undefined, locale?: string): string {
  if (!iso) return "";
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return "";
  return new Date(parsed).toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" });
}

const DEPLOYMENT_LABELS: Record<ConfigBlobSource["deployment"], string> = {
  cloud: "OpenWork Cloud",
  self_hosted: "self-hosted OpenWork",
};

/**
 * Where a chosen file came from, for the line under its name:
 * `Exported from "Acme Source" (OpenWork Cloud) on Nov 9, 2026. 11 areas.`,
 * or `Exported from this organization on …` when it is the current one.
 * Parts the file doesn't carry are left out.
 */
export function importFileSummary(
  file: { source: ConfigBlobSource | null; exportedAt: string | null; areaCount: number },
  currentOrganizationId: string | null,
  locale?: string,
): string {
  const day = formatDay(file.exportedAt, locale);
  const on = day ? ` on ${day}` : "";
  let origin = "";
  if (file.source && currentOrganizationId && file.source.organization.id === currentOrganizationId) {
    origin = `Exported from this organization${on}`;
  } else if (file.source) {
    origin = `Exported from "${file.source.organization.name}" (${DEPLOYMENT_LABELS[file.source.deployment]})${on}`;
  } else if (day) {
    origin = `Exported${on}`;
  }
  const areas = `${file.areaCount} ${file.areaCount === 1 ? "area" : "areas"}`;
  return origin ? `${origin}. ${areas}.` : `${areas}.`;
}

// ---------------------------------------------------------------------------
// Plan steps

export type ConfigStep = "match" | "references" | "secrets" | "people" | "review";

export type ConfigPlanEntry = { area: ConfigAreaKey; areaLabel: string; item: ConfigPlanItem };

export function planEntries(plan: ConfigPlan | null): ConfigPlanEntry[] {
  if (!plan) return [];
  return plan.areas.flatMap((area) => area.items.map((item) => ({ area: area.area, areaLabel: area.label, item })));
}

/**
 * Request-level issues to show above the steps. Item-level validation errors
 * (`Teams "Platform": …`) are left out: the item shows them on Review, where
 * it can be skipped, and they would stay on screen after it was.
 */
export function requestIssues(plan: ConfigPlan | null): ConfigPlan["issues"] {
  if (!plan) return [];
  const itemPrefixes = plan.areas.flatMap((area) => area.items.flatMap((item) => item.blob ? [`${area.label} "${item.blob.name}": `] : []));
  return plan.issues.filter((issue) => !(issue.level === "error" && itemPrefixes.some((prefix) => issue.message.startsWith(prefix))));
}

const RESTORE_CANT_UNDO_PREFIX = "These can't be undone by restoring: ";

/**
 * A restore's plan names, one warning per item, what the earlier change set off
 * that restoring can't undo. They read as one list: `{ cantUndo, rest }`.
 */
export function splitRestoreIssues(issues: ConfigPlan["issues"]): { cantUndo: string[]; rest: ConfigPlan["issues"] } {
  const cantUndo: string[] = [];
  const rest: ConfigPlan["issues"] = [];
  for (const issue of issues) {
    if (issue.message.startsWith(RESTORE_CANT_UNDO_PREFIX)) cantUndo.push(issue.message.slice(RESTORE_CANT_UNDO_PREFIX.length));
    else rest.push(issue);
  }
  return { cantUndo, rest };
}

export function needsMatch(item: ConfigPlanItem): boolean {
  return item.flags.includes("needs_mapping") || item.flags.includes("conflict.identity");
}

export function matchDecision(decisions: ConfigDecisions | null, entry: ConfigPlanEntry): string | null {
  return decisions?.matches.find((match) => match.area === entry.area && match.ref === entry.item.ref)?.targetId ?? null;
}

/** Items that need a match decision, plus those already decided here so the choice can be changed. */
export function matchEntries(plan: ConfigPlan | null, decisions: ConfigDecisions | null): ConfigPlanEntry[] {
  return planEntries(plan).filter((entry) => needsMatch(entry.item) || matchDecision(decisions, entry) !== null);
}

export type ConfigRefEntry = ConfigPlanEntry & { reference: ConfigPlanRef };

/** References that did not resolve on their own, decided or not. */
export function refEntries(plan: ConfigPlan | null): ConfigRefEntry[] {
  return planEntries(plan).flatMap((entry) => (entry.item.refs ?? [])
    // A reference to an item this same file adds ("planned") resolves on apply; it needs no decision.
    // One an admin chose to invite is also "planned", and stays listed so the choice can be changed.
    .filter((reference) => (reference.resolvedId === null && reference.via !== "planned") || reference.via === "decision" || reference.decision === "invite")
    .map((reference) => ({ ...entry, reference })));
}

export function isRefOpen(reference: ConfigPlanRef): boolean {
  return reference.resolvedId === null && reference.via !== "planned" && !reference.decision;
}

export function isPeopleRef(ref: ConfigPlanRef): boolean {
  return parseConfigRef(ref.ref)?.area === "people";
}

/** What a reference is called on screen: its name hint, else the handle as written. */
export function refName(reference: ConfigPlanRef): string {
  return reference.name ?? parseConfigRef(reference.ref)?.target ?? reference.ref;
}

/** A person's email, for the hover text of a row that shows their name; nothing for other references (their handle is an id). */
export function refHandle(reference: ConfigPlanRef): string | undefined {
  const parsed = parseConfigRef(reference.ref);
  return parsed?.area === "people" && parsed.target.includes("@") && parsed.target !== refName(reference) ? parsed.target : undefined;
}

/** A reference decision as the select's value: `target:<id>`, `invite`, `drop`, or "" when nothing is decided. */
export type ConfigRefChoice = string;

export function refChoice(decisions: ConfigDecisions | null, entry: ConfigRefEntry): ConfigRefChoice {
  const found = decisions?.refs.find((decision) => decision.area === entry.area && decision.ref === entry.item.ref && decision.path === entry.reference.path);
  if (!found) return "";
  if ("targetId" in found.resolution) return `target:${found.resolution.targetId}`;
  return "drop" in found.resolution ? "drop" : "invite";
}

/**
 * Every use of one referenced person or item: a person twelve items grant
 * access to is one decision, not twelve.
 */
export type ConfigRefGroup = {
  /** Stable React key: the handle as written, or one use's own key when uses can't be told apart. */
  key: string;
  name: string;
  reference: ConfigPlanRef;
  uses: ConfigRefEntry[];
  /** Uses that still need a decision. */
  open: number;
};

/** People the caller may not see all share this handle (`engine/people.ts`), so their uses are never grouped. */
const HIDDEN_PERSON_REF = "people/hidden";

/** Unresolved references grouped by what they point to, in the order the plan first mentions each. */
export function refGroups(plan: ConfigPlan | null): ConfigRefGroup[] {
  const groups = new Map<string, ConfigRefGroup>();
  for (const entry of refEntries(plan)) {
    const { reference } = entry;
    const key = reference.ref === HIDDEN_PERSON_REF ? `${entry.area}:${entry.item.ref}:${reference.path}` : reference.ref;
    const group = groups.get(key);
    const open = isRefOpen(reference) ? 1 : 0;
    if (!group) {
      groups.set(key, { key, name: refName(reference), reference, uses: [entry], open });
      continue;
    }
    group.uses.push(entry);
    group.open += open;
    // The first use that carries a name hint names the group.
    if (group.reference.name === undefined && reference.name !== undefined) {
      group.reference = reference;
      group.name = refName(reference);
    }
  }
  return [...groups.values()];
}

/** Whether the plan says it would refuse `choice` for this reference (`ConfigPlanRef.refuses`), so it isn't offered. */
export function refusesChoice(reference: ConfigPlanRef, choice: ConfigRefChoice): boolean {
  return (choice === "drop" || choice === "invite") && (reference.refuses ?? []).includes(choice);
}

/**
 * The choice a group's uses share, leaving aside uses that can't take it; ""
 * while some use is still free to take one, `null` when uses differ.
 */
export function refGroupChoice(decisions: ConfigDecisions | null, group: ConfigRefGroup): ConfigRefChoice | null {
  const chosen = new Set(group.uses.map((entry) => refChoice(decisions, entry)).filter((choice) => choice !== ""));
  if (chosen.size > 1) return null;
  const [choice] = chosen;
  if (choice === undefined) return "";
  return group.uses.every((entry) => refChoice(decisions, entry) === choice || refusesChoice(entry.reference, choice)) ? choice : "";
}

/**
 * A use whose decision the plan could not take, so it is still open: leaving
 * out the team a spend limit applies to, or a target that no longer exists.
 */
export function isRefChoiceRefused(decisions: ConfigDecisions | null, entry: ConfigRefEntry): boolean {
  return isRefOpen(entry.reference) && refChoice(decisions, entry) !== "";
}

/**
 * Decisions with `choice` set on every given use ("" clears them); other
 * decisions are kept, and so is a use the plan would refuse the choice for.
 */
export function decideRefs(decisions: ConfigDecisions, allUses: readonly ConfigRefEntry[], choice: ConfigRefChoice): ConfigDecisions {
  const useKey = (area: ConfigAreaKey, ref: string, path: string) => `${area}\u0000${ref}\u0000${path}`;
  const uses = allUses.filter((entry) => !refusesChoice(entry.reference, choice));
  const decided = new Set(uses.map((entry) => useKey(entry.area, entry.item.ref, entry.reference.path)));
  const rest = decisions.refs.filter((decision) => !decided.has(useKey(decision.area, decision.ref, decision.path)));
  if (!choice) return { ...decisions, refs: rest };
  const resolution: ConfigDecisions["refs"][number]["resolution"] = choice.startsWith("target:")
    ? { targetId: choice.slice("target:".length) }
    : choice === "invite" ? { invite: true } : { drop: true };
  return { ...decisions, refs: [...rest, ...uses.map((entry) => ({ area: entry.area, ref: entry.item.ref, path: entry.reference.path, resolution }))] };
}

/**
 * Invitations this request creates: the people it adds. A person a reference
 * chose to invite is one of them, once, however many items name that person.
 */
export function inviteCount(plan: ConfigPlan | null): number {
  return planEntries(plan).filter((entry) => entry.area === "members.people" && entry.item.op === "create").length;
}

export type ConfigStepInfo = { step: ConfigStep; label: string; open: number };

/** Steps that apply to this plan, with how many items still need a decision. */
export function planSteps(plan: ConfigPlan | null, decisions: ConfigDecisions | null): ConfigStepInfo[] {
  const steps: ConfigStepInfo[] = [];
  const matches = matchEntries(plan, decisions);
  if (matches.length > 0) steps.push({ step: "match", label: "Match", open: matches.filter((entry) => needsMatch(entry.item)).length });
  const refs = refEntries(plan);
  if (refs.length > 0) steps.push({ step: "references", label: "References", open: refs.filter((entry) => isRefOpen(entry.reference)).length });
  const secrets = planEntries(plan).flatMap((entry) => (entry.item.secrets ?? []).map((secret) => ({ entry, secret })));
  // Only secrets of items that write count as open; an unchanged item's placeholder changes nothing.
  if (secrets.length > 0) steps.push({ step: "secrets", label: "Secrets", open: secrets.filter(({ entry, secret }) => secret.decision === null && entry.item.flags.includes("needs_input")).length });
  if (inviteCount(plan) > 0) steps.push({ step: "people", label: "People", open: 0 });
  steps.push({ step: "review", label: "Review", open: reviewEntries(plan).length });
  return steps;
}

/** Flags resolved on the Review step: skip an invalid item, overwrite a drifted one, or rename a colliding one. */
export const CONFIG_REVIEW_FLAGS = ["blocked", "drift", "collision.unique"] as const;

/** Items that still need a decision on the Review step. */
export function reviewEntries(plan: ConfigPlan | null): ConfigPlanEntry[] {
  return planEntries(plan).filter((entry) => entry.item.flags.some((flag) => (CONFIG_REVIEW_FLAGS as readonly string[]).includes(flag)));
}

/** Secrets the target already holds a value for and nobody decided yet: "Keep all" sets them in one go. */
export function keepableSecrets(plan: ConfigPlan | null): string[] {
  return planEntries(plan).flatMap((entry) => (entry.item.secrets ?? [])
    .filter((secret) => secret.decision === null && secret.targetHasValue)
    .map((secret) => secret.path));
}

export function groupByOp(items: readonly ConfigPlanItem[]): Array<{ op: ConfigPlanOp; items: ConfigPlanItem[] }> {
  return CONFIG_OP_ORDER
    .map((op) => ({ op, items: items.filter((item) => item.op === op) }))
    .filter((group) => group.items.length > 0);
}

export function itemName(item: ConfigPlanItem): string {
  return item.blob?.name ?? item.target?.name ?? item.ref;
}

/** Target-side items a mirror import may remove; each needs its own tick. */
export function isDeletable(item: ConfigPlanItem, mode: ConfigPlan["mode"]): boolean {
  if (!item.target) return false;
  return item.op === "delete" || (mode === "mirror" && !item.blob && item.op === "untouched");
}

/**
 * What is already in the organization that a reference into an area could be
 * pointed at: the area's items in the plan when the file carries that area,
 * else the plan's own list for it (`refTargets`, a file that holds only part
 * of an organization).
 */
export function targetChoices(plan: ConfigPlan | null, area: ConfigAreaKey | "people"): Array<{ id: string; name: string }> {
  const key: ConfigAreaKey = area === "people" ? "members.people" : area;
  const seen = new Set<string>();
  const choices: Array<{ id: string; name: string }> = [];
  const add = (id: string, name: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    choices.push({ id, name });
  };
  for (const entry of planEntries(plan)) {
    if (entry.area === key && entry.item.target) add(entry.item.target.id, entry.item.target.name);
  }
  for (const listed of plan?.refTargets ?? []) {
    if (listed.area === key) for (const item of listed.items) add(item.id, item.name);
  }
  return choices;
}

/** Plain text for a field value in a diff; never raw JSON for simple values (DESIGN.md C3). */
export function formatFieldValue(value: unknown): string {
  if (value === undefined) return "—";
  if (value === null) return "Empty";
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (typeof value === "string") return value === "" ? "Empty" : value;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "None";
    return value.map((entry) => formatFieldValue(entry)).join(", ");
  }
  if (isPlainObject(value)) {
    if (typeof value.name === "string") return value.name;
    for (const key of ["id", "modelId", "key", "email"]) {
      const label = value[key];
      if (typeof label === "string" && Object.keys(value).length <= 2) return label;
    }
    if (typeof value.$ref === "string") return typeof value.name === "string" ? value.name : value.$ref;
    if (typeof value.$secret === "string") return value.set ? "Secret (set)" : "Secret (not set)";
    const text = JSON.stringify(value);
    return text.length > 120 ? `${text.slice(0, 117)}…` : text;
  }
  return String(value);
}

const FIELD_WORDS: Record<string, string> = { api: "API", url: "URL", urls: "URLs", id: "ID", ids: "IDs", mcp: "MCP", oauth: "OAuth", sso: "SSO", scim: "SCIM" };

/** `apiKeyAuthScheme` → `API key auth scheme` */
function humanizeField(field: string): string {
  const words = field.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(" ").map((word) => FIELD_WORDS[word.toLowerCase()] ?? word.toLowerCase());
  const first = words[0] ?? "";
  words[0] = FIELD_WORDS[first.toLowerCase()] ?? first.replace(/^./, (letter) => letter.toUpperCase());
  return words.join(" ");
}

/** The "Now" and "In the file" cells of a field change. Set-valued fields list what is added and removed. */
export function formatFieldChange(field: ConfigFieldChange): { now: string; file: string } {
  if (field.added !== undefined || field.removed !== undefined) {
    const removed = field.removed ?? [];
    const added = field.added ?? [];
    return {
      now: removed.length > 0 ? `Removes ${removed.map(formatFieldValue).join(", ")}` : "—",
      file: added.length > 0 ? `Adds ${added.map(formatFieldValue).join(", ")}` : "—",
    };
  }
  if (field.from === undefined && field.to !== undefined) return { now: "Not here", file: formatFieldValue(field.to) };
  if (field.to === undefined && field.from !== undefined) return { now: formatFieldValue(field.from), file: "Removed" };
  return { now: formatFieldValue(field.from), file: formatFieldValue(field.to) };
}

/** `models[id=claude-opus-4].enabled` → `Models › claude-opus-4 › Enabled` */
export function formatFieldPath(path: string): string {
  if (path === "(spec)") return "Settings";
  const segments: string[] = [];
  // Field names are humanized; bracketed parts (`[id=x]`, `[0]`, `[*]`) are values and shown as written.
  for (const match of path.matchAll(/\[([^\]]*)\]|([^.[\]]+)/g)) {
    const [, bracket, field] = match;
    if (bracket !== undefined) {
      segments.push(bracket.includes("=") ? bracket.slice(bracket.indexOf("=") + 1) : bracket);
    } else if (field) {
      segments.push(/^[a-z][A-Za-z0-9]*$/.test(field) ? humanizeField(field) : field);
    }
  }
  return segments.join(" › ");
}

// ---------------------------------------------------------------------------
// Apply runs (one report per apply attempt)

/** What admins call reverting: it restores configuration only, never side effects. */
export const RESTORE_ACTION_LABEL = "Restore previous config";

/**
 * Whether "Restore previous config" is offered: the change was applied (or
 * part of it), and no restore of it is open or done. den-api drops the link
 * to a restore that was cancelled, refused or superseded, so it can be started again.
 */
export function canRestoreRequest(request: Pick<ConfigChangeRequestSummary, "status" | "revertedByChangeRequestId">, runCount: number): boolean {
  return (request.status === "applied" || request.status === "failed") && !request.revertedByChangeRequestId && runCount > 0;
}

/** Heading of an area's removals: a restore only offers what the restored change added. */
export function deletesHeading(restore: boolean): string {
  return restore ? "Added by the change being restored: remove?" : "Not in the file: remove?";
}

export const CONFIG_RUN_STATUS_PRESENTATION: Record<ConfigApplyRunStatus, { label: string; tone: DenChipTone }> = {
  running: { label: "Applying", tone: "info" },
  applied: { label: "Applied", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  interrupted: { label: "Stopped part-way", tone: "danger" },
};

export const CONFIG_ITEM_STATUS_PRESENTATION: Record<ConfigApplyItemStatus, { label: string; tone: DenChipTone }> = {
  applied: { label: "Done", tone: "success" },
  noop: { label: "Already up to date", tone: "neutral" },
  failed: { label: "Failed", tone: "danger" },
  not_reached: { label: "Not reached", tone: "neutral" },
  skipped: { label: "Not run", tone: "neutral" },
};

const STEP_VERBS: Record<"done" | "attempted", Record<ConfigApplyStep["action"], string>> = {
  done: { create: "Created", update: "Updated", delete: "Deleted", add: "Added", remove: "Removed", set: "Set", keep: "Kept" },
  // A write that failed didn't happen: name it as what was tried.
  attempted: { create: "Create", update: "Update", delete: "Delete", add: "Add", remove: "Remove", set: "Set", keep: "Keep" },
};

/** `{ action: "add", target: "access.teams", detail: "Platform" }` → `Added Access › Teams: Platform` */
export function formatApplyStep(step: ConfigApplyStep, tense: "done" | "attempted" = "done"): string {
  const verb = STEP_VERBS[tense][step.action];
  const target = step.target ? formatFieldPath(step.target) : "";
  const head = target ? `${verb} ${target}` : verb;
  return step.detail ? `${head}: ${step.detail}` : head;
}

/** `1.2 s`, `350 ms`, `2 min 5 s`; empty when unknown. */
export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds > 0 ? `${minutes} min ${seconds} s` : `${minutes} min`;
}

/** How long a run took (or has been running), from its start and end. */
export function runDurationMs(run: Pick<ConfigApplyReport, "startedAt" | "finishedAt">, now = Date.now()): number | null {
  const started = Date.parse(run.startedAt);
  const finished = run.finishedAt ? Date.parse(run.finishedAt) : now;
  return Number.isNaN(started) || Number.isNaN(finished) ? null : Math.max(0, finished - started);
}

/** `3 done, 1 failed, 2 not reached`: only the non-zero counts. */
export function formatRunCounts(counts: ConfigApplyReport["counts"]): string {
  const parts: string[] = [];
  if (counts.applied > 0) parts.push(`${counts.applied} done`);
  if (counts.noop > 0) parts.push(`${counts.noop} already up to date`);
  if (counts.failed > 0) parts.push(`${counts.failed} failed`);
  if (counts.not_reached > 0) parts.push(`${counts.not_reached} not reached`);
  if (counts.skipped > 0) parts.push(`${counts.skipped} not run`);
  return parts.length > 0 ? parts.join(", ") : "Nothing to apply";
}

/** `Ada Example`, `Ada Example with the token "CI"`, or `a member`. */
export function runRequester(run: Pick<ConfigApplyReport, "requestedBy">): string {
  const by = run.requestedBy;
  if (!by) return "a member";
  const name = by.name ?? "a member";
  return by.apiKeyName ? `${name} with the token "${by.apiKeyName}"` : name;
}

/** `AI Providers › OpenAI › Base URL`: where an item failed (area, item, then the field or the failed write). */
export function failureLocation(areaLabel: string, item: Pick<ConfigApplyReportItem, "name" | "failure">): string {
  const parts = [areaLabel, item.name];
  if (item.failure?.field) parts.push(formatFieldPath(item.failure.field));
  else if (item.failure?.step) parts.push(formatApplyStep(item.failure.step, "attempted"));
  return parts.join(" › ");
}

export type ConfigRunFailure = {
  item: ConfigApplyReportItem;
  /** `Area › Item › Field`. */
  where: string;
  /** The write that failed, in words, when the adapter said which. */
  failedStep: string | null;
  message: string;
  /** Writes already done for the failed item, in words. */
  written: string[];
  /** Items after it that never ran. */
  notReached: ConfigApplyReportItem[];
  interrupted: boolean;
};

/** The failed item of a run, explained: what failed, where, what was already written, what was not reached. */
export function runFailure(run: ConfigApplyReport, areaLabel: (area: ConfigAreaKey) => string): ConfigRunFailure | null {
  const item = run.items.find((entry) => entry.status === "failed");
  if (!item) return null;
  return {
    item,
    where: failureLocation(areaLabel(item.area), item),
    failedStep: item.failure?.step ? formatApplyStep(item.failure.step, "attempted") : null,
    message: item.failure?.message ?? item.error ?? "It failed without a message.",
    written: item.steps.map((step) => formatApplyStep(step)),
    notReached: run.items.filter((entry) => entry.status === "not_reached"),
    interrupted: item.failure?.code === "interrupted",
  };
}

/** Effects of a run that restoring the previous config can't undo, one line per item. */
export function runIrreversible(run: ConfigApplyReport, areaLabel: (area: ConfigAreaKey) => string): string[] {
  return run.items
    .filter((item) => item.irreversible.length > 0 && (item.status === "applied" || item.steps.length > 0))
    .map((item) => `${areaLabel(item.area)} › ${item.name}: ${item.irreversible.join("; ")}`);
}
