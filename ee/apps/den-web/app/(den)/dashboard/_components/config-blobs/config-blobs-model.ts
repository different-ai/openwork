import {
  CONFIG_BLOB_MAX_BYTES,
  configBlobSchema,
  type ConfigAreaDescriptor,
  type ConfigAreaKey,
  type ConfigBlob,
  type ConfigChangeRequestStatus,
  type ConfigDecisions,
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
  cancelled: { label: "Cancelled", tone: "neutral" },
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

// ---------------------------------------------------------------------------
// Import file

export type ImportFileCheck =
  | { ok: true; blob: ConfigBlob; areaCount: number; sourceName: string | null }
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
  return { ok: true, blob, areaCount: result.data.scope.length, sourceName: result.data.source?.organization.name ?? null };
}

function isAreasTree(value: Record<string, unknown>): value is ConfigBlob["areas"] {
  return Object.values(value).every(isPlainObject);
}

// ---------------------------------------------------------------------------
// Plan steps

export type ConfigStep = "match" | "references" | "secrets" | "people" | "review";

export type ConfigPlanEntry = { area: ConfigAreaKey; areaLabel: string; item: ConfigPlanItem };

export function planEntries(plan: ConfigPlan | null): ConfigPlanEntry[] {
  if (!plan) return [];
  return plan.areas.flatMap((area) => area.items.map((item) => ({ area: area.area, areaLabel: area.label, item })));
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
    .filter((reference) => reference.resolvedId === null || reference.via === "decision")
    .map((reference) => ({ ...entry, reference })));
}

export function isRefOpen(reference: ConfigPlanRef): boolean {
  return reference.resolvedId === null && !reference.decision;
}

export function isPeopleRef(ref: ConfigPlanRef): boolean {
  return parseConfigRef(ref.ref)?.area === "people";
}

/** Invitations this request creates: new people in `members.people`, plus people references set to invite. */
export function inviteCount(plan: ConfigPlan | null, decisions: ConfigDecisions | null): number {
  const created = planEntries(plan).filter((entry) => entry.area === "members.people" && entry.item.op === "create").length;
  const invitedRefs = decisions?.refs.filter((ref) => "invite" in ref.resolution).length ?? 0;
  return created + invitedRefs;
}

export type ConfigStepInfo = { step: ConfigStep; label: string; open: number };

/** Steps that apply to this plan, with how many items still need a decision. */
export function planSteps(plan: ConfigPlan | null, decisions: ConfigDecisions | null): ConfigStepInfo[] {
  const steps: ConfigStepInfo[] = [];
  const matches = matchEntries(plan, decisions);
  if (matches.length > 0) steps.push({ step: "match", label: "Match", open: matches.filter((entry) => needsMatch(entry.item)).length });
  const refs = refEntries(plan);
  if (refs.length > 0) steps.push({ step: "references", label: "References", open: refs.filter((entry) => isRefOpen(entry.reference)).length });
  const secrets = planEntries(plan).flatMap((entry) => entry.item.secrets ?? []);
  if (secrets.length > 0) steps.push({ step: "secrets", label: "Secrets", open: secrets.filter((secret) => secret.decision === null).length });
  if (inviteCount(plan, decisions) > 0) steps.push({ step: "people", label: "People", open: 0 });
  steps.push({ step: "review", label: "Review", open: 0 });
  return steps;
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

/** Target items of an area the plan already knows about: choices for mapping a reference. */
export function targetChoices(plan: ConfigPlan | null, area: ConfigAreaKey | "people"): Array<{ id: string; name: string }> {
  const key: ConfigAreaKey = area === "people" ? "members.people" : area;
  const seen = new Set<string>();
  const choices: Array<{ id: string; name: string }> = [];
  for (const entry of planEntries(plan)) {
    if (entry.area !== key || !entry.item.target || seen.has(entry.item.target.id)) continue;
    seen.add(entry.item.target.id);
    choices.push({ id: entry.item.target.id, name: entry.item.target.name });
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
    if (typeof value.$ref === "string") return typeof value.name === "string" ? value.name : value.$ref;
    if (typeof value.$secret === "string") return value.set ? "Secret (set)" : "Secret (not set)";
    const text = JSON.stringify(value);
    return text.length > 120 ? `${text.slice(0, 117)}…` : text;
  }
  return String(value);
}

/** `models[claude-opus-4].enabled` → `Models › claude-opus-4 › Enabled` */
export function formatFieldPath(path: string): string {
  return path
    .split(/\.|\[|\]/)
    .filter(Boolean)
    .map((segment, index) => (index === 0 || /^[a-z]/.test(segment)) && !segment.includes("-")
      ? segment.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (first) => first.toUpperCase())
      : segment)
    .join(" › ");
}
