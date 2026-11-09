import { z } from "zod";

/**
 * Config blobs: export / import of an organization's configuration as JSON.
 * Design: docs/features/config-blobs/. Shared by den-api (engine, adapters,
 * routes) and den-web (Settings › Config). Feature flag: `configBlobs`.
 */

export const CONFIG_BLOB_FORMAT = "openwork.config-blob" as const;
export const CONFIG_BLOB_FORMAT_VERSION = 1 as const;
/** Largest blob accepted inline, in bytes of JSON. */
export const CONFIG_BLOB_MAX_BYTES = 5 * 1024 * 1024;
/** Most items one area of a blob may hold. */
export const CONFIG_BLOB_MAX_ITEMS_PER_AREA = 2_000;
/** Most items a whole blob may hold. */
export const CONFIG_BLOB_MAX_ITEMS = 20_000;
/** Deepest nesting of objects and arrays inside an item's spec. */
export const CONFIG_BLOB_MAX_SPEC_DEPTH = 32;
/** Object keys never accepted anywhere in a blob's areas (prototype pollution). */
export const CONFIG_BLOB_FORBIDDEN_KEYS: readonly string[] = ["__proto__", "constructor", "prototype"];

export function isForbiddenConfigKey(key: string): boolean {
  return CONFIG_BLOB_FORBIDDEN_KEYS.includes(key);
}

/**
 * Checks a value from a blob for keys that could pollute prototypes and for
 * nesting deeper than `maxDepth` containers. Returns the first problem found,
 * or null. Iterative, so a hostile nesting depth cannot overflow the stack.
 */
export function findConfigShapeProblem(value: unknown, path: string, maxDepth: number = CONFIG_BLOB_MAX_SPEC_DEPTH): string | null {
  const stack: Array<{ value: unknown; path: string; depth: number }> = [{ value, path, depth: 0 }];
  while (stack.length > 0) {
    const next = stack.pop();
    if (!next || typeof next.value !== "object" || next.value === null) continue;
    if (next.depth >= maxDepth) return `${next.path}: nested more than ${maxDepth} levels deep`;
    if (Array.isArray(next.value)) {
      next.value.forEach((element, index) => stack.push({ value: element, path: `${next.path}[${index}]`, depth: next.depth + 1 }));
      continue;
    }
    for (const [key, child] of Object.entries(next.value)) {
      if (isForbiddenConfigKey(key)) return `${next.path}: the key "${key}" is not allowed`;
      stack.push({ value: child, path: `${next.path}.${key}`, depth: next.depth + 1 });
    }
  }
  return null;
}

/**
 * Area keys. Dotted paths that follow the Den sidebar (page.sub-page), fixed
 * forever once shipped: the UI may move, the key does not. In a blob file the
 * dots nest: `areas["ai-gateway"]["providers"]`.
 */
export const CONFIG_AREA_KEYS = [
  "members.teams",
  "members.roles",
  "members.people",
  "connectors.oauth-clients",
  "connectors.mcp",
  "ai-gateway.providers",
  "ai-gateway.byok",
  "desktop-policies",
  "settings.general",
  "settings.web-origins",
  "settings.advanced.collections",
] as const;
export type ConfigAreaKey = (typeof CONFIG_AREA_KEYS)[number];
export const configAreaKeySchema = z.enum(CONFIG_AREA_KEYS);

export function isConfigAreaKey(value: string): value is ConfigAreaKey {
  return (CONFIG_AREA_KEYS as readonly string[]).includes(value);
}

/** Same rule as the existing declarative `externalKey`. */
export const configItemKeySchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/);

/**
 * A reference to another item: `"<area>/<id or key>"`, or `"people/<email>"`.
 * `name` is a hint for people reading the file and is ignored on import.
 * After resolution the engine adds `id`: the local id on the target.
 */
export const configRefSchema = z.object({
  $ref: z.string().min(3).max(300),
  name: z.string().max(300).optional(),
}).strict();
export type ConfigRef = z.infer<typeof configRefSchema>;
export type ResolvedConfigRef = ConfigRef & { id: string };

export function isConfigRef(value: unknown): value is ConfigRef {
  return typeof value === "object" && value !== null && !Array.isArray(value) && typeof (value as { $ref?: unknown }).$ref === "string";
}

export function parseConfigRef(ref: string): { area: ConfigAreaKey | "people"; target: string } | null {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) return null;
  const area = ref.slice(0, slash);
  const target = ref.slice(slash + 1);
  if (area === "people") return { area, target };
  return isConfigAreaKey(area) ? { area, target } : null;
}

/**
 * A secret placeholder. Exported as `{ $secret, set }`. On upload the author
 * may instead say `keep`, `env` (self-hosted, operator allowlist) or `unset`.
 * Values are never accepted inside a blob; they go through the inputs endpoint.
 */
export const configSecretSchema = z.object({
  $secret: z.string().min(1).max(300),
  set: z.boolean().optional(),
  keep: z.literal(true).optional(),
  env: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/).optional(),
  unset: z.literal(true).optional(),
}).strict();
export type ConfigSecret = z.infer<typeof configSecretSchema>;

export function isConfigSecret(value: unknown): value is ConfigSecret {
  return typeof value === "object" && value !== null && !Array.isArray(value) && typeof (value as { $secret?: unknown }).$secret === "string";
}

/** What the engine hands an adapter in place of a placeholder at apply time. */
export type ResolvedConfigSecret =
  | { $secret: string; decision: "keep" }
  | { $secret: string; decision: "value"; value: string }
  | { $secret: string; decision: "unset" };

export type ConfigSpec = { [key: string]: unknown };

export const configBlobItemSchema = z.object({
  /** Source TypeID. Optional for hand-written items. */
  id: z.string().min(1).max(100).optional(),
  key: configItemKeySchema.nullable().optional(),
  name: z.string().min(1).max(300),
  /** `sha256:` hash of the canonical spec at export: the three-way base. */
  rev: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  spec: z.record(z.string(), z.unknown()),
}).strict();
export type ConfigBlobItem = z.infer<typeof configBlobItemSchema>;

export const configBlobAreaSchema = z.object({
  specVersion: z.number().int().min(1),
  items: z.array(configBlobItemSchema),
}).strict();
export type ConfigBlobArea = z.infer<typeof configBlobAreaSchema>;

export const configDeploymentSchema = z.enum(["cloud", "self_hosted"]);
export type ConfigDeployment = z.infer<typeof configDeploymentSchema>;

export const configBlobSourceSchema = z.object({
  deployment: configDeploymentSchema,
  instanceId: z.string().min(1).max(100),
  appVersion: z.string().max(64),
  organization: z.object({ id: z.string(), slug: z.string(), name: z.string() }).strict(),
}).strict();
export type ConfigBlobSource = z.infer<typeof configBlobSourceSchema>;

export const configBlobSecretIndexEntrySchema = z.object({
  path: z.string(),
  area: configAreaKeySchema,
  itemId: z.string().optional(),
  itemName: z.string(),
  field: z.string(),
  set: z.boolean(),
}).strict();
export type ConfigBlobSecretIndexEntry = z.infer<typeof configBlobSecretIndexEntrySchema>;

/** Nested areas as they appear in the file. Leaves are `ConfigBlobArea`. */
export type ConfigBlobAreasTree = { [segment: string]: ConfigBlobAreasTree | ConfigBlobArea };

export const configBlobSchema = z.object({
  $schema: z.string().optional(),
  format: z.literal(CONFIG_BLOB_FORMAT),
  formatVersion: z.literal(CONFIG_BLOB_FORMAT_VERSION),
  exportedAt: z.string().optional(),
  source: configBlobSourceSchema.optional(),
  scope: z.array(configAreaKeySchema).min(1),
  baseHash: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  areas: z.record(z.string(), z.unknown()),
  secrets: z.array(configBlobSecretIndexEntrySchema).optional(),
  /** Areas left out of an export because the exporter could not view them. */
  omitted: z.array(z.object({ area: configAreaKeySchema, reason: z.string() }).strict()).optional(),
}).strict();
export type ConfigBlob = Omit<z.infer<typeof configBlobSchema>, "areas"> & { areas: ConfigBlobAreasTree };

/** `{"ai-gateway.providers": area}` → `{"ai-gateway": {"providers": area}}`. */
export function nestConfigAreas(flat: Partial<Record<ConfigAreaKey, ConfigBlobArea>>): ConfigBlobAreasTree {
  const root: ConfigBlobAreasTree = {};
  for (const [key, area] of Object.entries(flat)) {
    if (!area) continue;
    const segments = key.split(".");
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      const next = node[segment];
      if (next && !("items" in next)) node = next as ConfigBlobAreasTree;
      else {
        const created: ConfigBlobAreasTree = {};
        node[segment] = created;
        node = created;
      }
    }
    node[segments[segments.length - 1]!] = area;
  }
  return root;
}

/**
 * The inverse of `nestConfigAreas`. Returns parse errors for leaves that are
 * not valid areas or paths that are not known area keys.
 */
export function flattenConfigAreas(tree: unknown): { areas: Partial<Record<ConfigAreaKey, ConfigBlobArea>>; errors: string[] } {
  const areas: Partial<Record<ConfigAreaKey, ConfigBlobArea>> = {};
  const errors: string[] = [];
  let total = 0;
  const walk = (node: unknown, path: string[]) => {
    if (typeof node !== "object" || node === null || Array.isArray(node)) {
      errors.push(`areas.${path.join(".")} must be an object`);
      return;
    }
    // Area keys are at most three segments deep ("settings.advanced.collections").
    if (path.length > 3) {
      errors.push(`unknown area "${path.join(".")}"`);
      return;
    }
    if ("items" in node) {
      const key = path.join(".");
      if (!isConfigAreaKey(key)) {
        errors.push(`unknown area "${key}"`);
        return;
      }
      const rawItems = node.items;
      if (Array.isArray(rawItems)) {
        if (rawItems.length > CONFIG_BLOB_MAX_ITEMS_PER_AREA) {
          errors.push(`areas.${key}: ${rawItems.length} items is more than the ${CONFIG_BLOB_MAX_ITEMS_PER_AREA.toLocaleString("en-US")} allowed in one area`);
          return;
        }
        total += rawItems.length;
        if (total > CONFIG_BLOB_MAX_ITEMS) {
          errors.push(`the blob has more than the ${CONFIG_BLOB_MAX_ITEMS.toLocaleString("en-US")} items allowed in one file`);
          return;
        }
      }
      // Checked on the raw input: schema parsing may silently drop a `__proto__` key.
      const shape = findConfigShapeProblem(rawItems, `areas.${key}.items`, CONFIG_BLOB_MAX_SPEC_DEPTH + 2);
      if (shape) {
        errors.push(shape);
        return;
      }
      const parsed = configBlobAreaSchema.safeParse(node);
      if (!parsed.success) {
        errors.push(...parsed.error.issues.map((issue) => `areas.${key}.${issue.path.join(".")}: ${issue.message}`));
        return;
      }
      areas[key] = parsed.data;
      return;
    }
    for (const [segment, child] of Object.entries(node)) walk(child, [...path, segment]);
  };
  walk(tree, []);
  return { areas, errors };
}

// ---------------------------------------------------------------------------
// Plans

export const CONFIG_IMPORT_MODES = ["merge", "mirror"] as const;
export type ConfigImportMode = (typeof CONFIG_IMPORT_MODES)[number];

export const CONFIG_PLAN_OPS = ["create", "update", "rename", "unchanged", "delete", "untouched", "skip"] as const;
export type ConfigPlanOp = (typeof CONFIG_PLAN_OPS)[number];

export const CONFIG_PLAN_FLAGS = [
  "needs_mapping",
  "needs_input",
  "ref_unresolved",
  "drift",
  "collision.unique",
  "conflict.identity",
  "destructive",
  "external_effect",
  "unsupported_field",
  "blocked",
] as const;
export type ConfigPlanFlag = (typeof CONFIG_PLAN_FLAGS)[number];
/** Flags that stop a plan from being approved until resolved. */
export const CONFIG_BLOCKING_FLAGS: readonly ConfigPlanFlag[] = [
  "needs_mapping",
  "needs_input",
  "ref_unresolved",
  "drift",
  "collision.unique",
  "conflict.identity",
  "blocked",
];

export const CONFIG_MATCH_TIERS = ["id", "alias", "decision", "key", "natural", "proposed"] as const;
export type ConfigMatchTier = (typeof CONFIG_MATCH_TIERS)[number];

export type ConfigFieldChange = {
  path: string;
  from?: unknown;
  to?: unknown;
  /** Value at export, when known (three-way). */
  base?: unknown;
  /** Changed on both sides since export. */
  conflict?: boolean;
  /** For set-valued fields (e.g. `access.teams`): elements added / removed. */
  added?: unknown[];
  removed?: unknown[];
};

export type ConfigMatchCandidate = { id: string; name: string; score: number; reasons: string[] };

export type ConfigPlanSecret = {
  path: string;
  field: string;
  targetHasValue: boolean;
  sourceHadValue: boolean;
  decision: "keep" | "env" | "value" | "unset" | null;
  env?: string;
};

export type ConfigPlanRef = {
  /** Spec path where the reference sits, e.g. `access.teams[0]`. */
  path: string;
  ref: string;
  name?: string;
  resolvedId: string | null;
  /** How it resolved: an existing target item, a planned create in this request, or an explicit decision. */
  via: "target" | "planned" | "decision" | null;
  decision?: "drop" | "invite" | null;
};

export type ConfigPlanItem = {
  area: ConfigAreaKey;
  /** Stable handle for decisions: the blob item's id, else `key:<key>`, else `#<index>`. Target-only items use `target:<id>`. */
  ref: string;
  op: ConfigPlanOp;
  blob?: { id?: string; key?: string | null; name: string };
  target?: { id: string; key?: string | null; name: string };
  matchedBy: ConfigMatchTier | null;
  flags: ConfigPlanFlag[];
  reasons?: string[];
  fields: ConfigFieldChange[];
  candidates?: ConfigMatchCandidate[];
  secrets?: ConfigPlanSecret[];
  refs?: ConfigPlanRef[];
  /** Hash of the target's current spec this item was planned against. */
  targetRev?: string;
};

export type ConfigPlanSummary = Record<ConfigPlanOp, number> & { blocking: number };

export type ConfigPlan = {
  planHash: string;
  mode: ConfigImportMode;
  summary: ConfigPlanSummary;
  areas: Array<{ area: ConfigAreaKey; label: string; items: ConfigPlanItem[] }>;
  /** Request-level problems (version skew, omitted areas, …). */
  issues: Array<{ level: "error" | "warning" | "info"; message: string; area?: ConfigAreaKey }>;
};

// ---------------------------------------------------------------------------
// Decisions and inputs

export const configDecisionsSchema = z.object({
  matches: z.array(z.object({ area: configAreaKeySchema, ref: z.string(), targetId: z.union([z.string(), z.literal("create")]) }).strict()).default([]),
  refs: z.array(z.object({ area: configAreaKeySchema, ref: z.string(), path: z.string(), resolution: z.union([
    z.object({ targetId: z.string() }).strict(),
    z.object({ drop: z.literal(true) }).strict(),
    z.object({ invite: z.literal(true) }).strict(),
  ]) }).strict()).default([]),
  deletes: z.array(z.object({ area: configAreaKeySchema, targetId: z.string() }).strict()).default([]),
  /** Overwrite a drifted item with the blob anyway. */
  overrides: z.array(z.object({ area: configAreaKeySchema, ref: z.string() }).strict()).default([]),
  skips: z.array(z.object({ area: configAreaKeySchema, ref: z.string() }).strict()).default([]),
  /** For a create that collides on a unique name: the new name to use. */
  renames: z.array(z.object({ area: configAreaKeySchema, ref: z.string(), name: z.string().min(1).max(300) }).strict()).default([]),
  people: z.object({ sendInviteEmails: z.boolean().default(false) }).strict().default({ sendInviteEmails: false }),
}).strict();
export type ConfigDecisions = z.infer<typeof configDecisionsSchema>;
export const EMPTY_CONFIG_DECISIONS: ConfigDecisions = { matches: [], refs: [], deletes: [], overrides: [], skips: [], renames: [], people: { sendInviteEmails: false } };

export const configSecretInputSchema = z.discriminatedUnion("decision", [
  z.object({ path: z.string(), decision: z.literal("keep") }).strict(),
  z.object({ path: z.string(), decision: z.literal("unset") }).strict(),
  z.object({ path: z.string(), decision: z.literal("env"), env: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/) }).strict(),
  z.object({ path: z.string(), decision: z.literal("value"), value: z.string().min(1).max(64 * 1024) }).strict(),
]);
export type ConfigSecretInput = z.infer<typeof configSecretInputSchema>;
export const configSecretInputsSchema = z.object({ inputs: z.array(configSecretInputSchema).max(500) }).strict();

// ---------------------------------------------------------------------------
// Change requests

export const CONFIG_CHANGE_REQUEST_STATUSES = [
  "uploaded",
  "analyzing",
  "invalid",
  "needs_review",
  "approved",
  "queued",
  "applying",
  "applied",
  "failed",
  "stale",
  "superseded",
  "cancelled",
] as const;
export type ConfigChangeRequestStatus = (typeof CONFIG_CHANGE_REQUEST_STATUSES)[number];
export const CONFIG_CHANGE_REQUEST_OPEN_STATUSES: readonly ConfigChangeRequestStatus[] = ["uploaded", "analyzing", "needs_review", "approved", "queued", "applying", "stale"];

export const CONFIG_CHANGE_REQUEST_SOURCES = ["ui", "api", "revert"] as const;
export type ConfigChangeRequestSource = (typeof CONFIG_CHANGE_REQUEST_SOURCES)[number];

export const createConfigChangeRequestSchema = z.object({
  blob: z.unknown(),
  mode: z.enum(CONFIG_IMPORT_MODES).default("merge"),
  title: z.string().trim().min(1).max(200).optional(),
  autoApply: z.boolean().default(false),
}).strict();
export type CreateConfigChangeRequest = z.infer<typeof createConfigChangeRequestSchema>;

export const approveConfigChangeRequestSchema = z.object({ planHash: z.string() }).strict();

export type ConfigChangeRequestSummary = {
  id: string;
  status: ConfigChangeRequestStatus;
  title: string | null;
  mode: ConfigImportMode;
  source: ConfigChangeRequestSource;
  sourceOrganization: { id: string; slug: string; name: string } | null;
  sourceDeployment: ConfigDeployment | null;
  areas: ConfigAreaKey[];
  summary: ConfigPlanSummary | null;
  planHash: string | null;
  approvals: Array<{ memberId: string; name: string | null; at: string }>;
  autoApply: boolean;
  createdBy: { memberId: string | null; name: string | null; apiKeyName: string | null };
  revertsChangeRequestId: string | null;
  revertedByChangeRequestId: string | null;
  errors: string[];
  createdAt: string;
  updatedAt: string;
  appliedAt: string | null;
};

export type ConfigApplyReport = {
  items: Array<{ area: ConfigAreaKey; ref: string; op: ConfigPlanOp; localId: string | null; status: "applied" | "failed" | "skipped"; warnings: string[]; error?: string }>;
  warnings: string[];
  /** `rev` of every item in scope right after the apply, keyed `<area>/<id>`: the three-way base of a revert. */
  afterRevs?: Record<string, string>;
};

/** Organization settings for config change requests (GET/PATCH `/v1/config-blobs/settings`). */
export type ConfigBlobSettings = {
  /** Two different approvers; the second must be neither the creator nor the first approver (D5). */
  requireSecondApprover: boolean;
};
export const configBlobSettingsPatchSchema = z.object({ requireSecondApprover: z.boolean() }).strict();
export type ConfigBlobSettingsResponse = { settings: ConfigBlobSettings };

export type ConfigAreaDescriptor = {
  key: ConfigAreaKey;
  label: string;
  /** Sidebar breadcrumb for the export tree, e.g. ["AI Gateway", "AI Providers"]. */
  path: string[];
  specVersion: number;
  supported: boolean;
  unsupportedReason?: string;
  canExport: boolean;
  canImport: boolean;
  containsConfidentialContent: boolean;
  secretFields: string[];
};

// ---------------------------------------------------------------------------
// HTTP API shapes (den-api `/v1/config-blobs/*`, consumed by den-web)

export type ConfigAreasResponse = {
  areas: ConfigAreaDescriptor[];
  deployment: ConfigDeployment;
  /** Whether `env` secret decisions are allowed here (self-hosted with an operator allowlist). */
  allowEnvSecrets: boolean;
};
export type ConfigChangeRequestResponse = { changeRequest: ConfigChangeRequestSummary };
export type ConfigChangeRequestListResponse = { changeRequests: ConfigChangeRequestSummary[] };
export type ConfigChangeRequestDetailResponse = { changeRequest: ConfigChangeRequestSummary; report: ConfigApplyReport | null };
export type ConfigChangeRequestPlanResponse = { plan: ConfigPlan | null; decisions: ConfigDecisions };
export type ConfigChangeRequestPlanUpdateResponse = { changeRequest: ConfigChangeRequestSummary; plan: ConfigPlan | null };
