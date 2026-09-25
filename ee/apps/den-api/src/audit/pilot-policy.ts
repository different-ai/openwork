import { parseArgs } from "node:util"
import { appendAuditEvent, type AuditDatabase, type AuditPolicy, type AuditTx } from "@openwork-ee/den-db/audit-log"
import { MAX_AUDIT_RETENTION_CANDIDATES, MAX_AUDIT_RETENTION_OPERATIONS, previewAuditRetention } from "@openwork-ee/den-db/audit-accounting"
import { and, asc, eq, sql } from "@openwork-ee/den-db/drizzle"
import { AuditOperationTable, AuditPolicyTable, AuditStateTable, OrganizationTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId, typeId } from "@openwork-ee/utils/typeid"
import type { AuditCategory } from "@openwork/types/den/audit"
import { z } from "zod"

export const PILOT_DEFAULT_CATEGORIES: readonly AuditCategory[] = ["change", "security", "execution", "access", "request", "lifecycle"]
export const PILOT_SYSTEM_ACTOR = "den-api.audit-pilot"
const pilotCategorySchema = z.enum(["change", "security", "execution", "access", "read", "request", "lifecycle"])
const pilotConfigSchema = z.object({
  organizationId: typeId.schema("organization"),
  source: z.enum(["cloud", "operator"]),
  allowance: z.number().int().nonnegative().safe(),
  attachmentWindowSeconds: z.number().int().min(1).max(86_400),
  excessMode: z.enum(["delete_oldest", "keep_all"]),
  categories: z.array(pilotCategorySchema).max(7).refine((values) => new Set(values).size === values.length).optional(),
  operatorReference: z.string().min(1).max(64).regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/i)
    .refine((value) => !/^(?:sk-|gh[pousr]_|AIza|eyJ)|(?:secret|password|token|credential)/i.test(value)).optional(),
}).strict().refine((value) => value.source !== "cloud" || value.excessMode === "delete_oldest")

export type PilotConfig = Omit<z.infer<typeof pilotConfigSchema>, "categories"> & { categories: AuditCategory[] }
export type PilotFlags = { auditCaptureEnabled: boolean; auditVisibilityEnabled: boolean }
export type PilotCommand =
  | { mode: "help" }
  | { mode: "preview-retention"; organizationId: string }
  | { mode: "dry-run" | "apply"; config: PilotConfig }

export class AuditPilotError extends Error {
  constructor(readonly code:
    | "audit_pilot_invalid_arguments"
    | "audit_pilot_organization_not_found"
    | "audit_pilot_policy_exists"
    | "audit_pilot_policy_missing"
    | "audit_pilot_storage_inconsistent"
    | "audit_pilot_retention_incomplete_snapshot"
    | "audit_pilot_retention_unsupported_policy"
  ) {
    super(code)
    this.name = "AuditPilotError"
  }
}

export function validatePilotConfig(input: unknown): PilotConfig {
  const parsed = pilotConfigSchema.safeParse(input)
  if (!parsed.success) throw new AuditPilotError("audit_pilot_invalid_arguments")
  const config = parsed.data
  const selected = new Set(config.categories ?? PILOT_DEFAULT_CATEGORIES)
  selected.add("lifecycle")
  return { ...config, categories: pilotCategorySchema.options.filter((category) => selected.has(category)) }
}

export function parsePilotArgs(args: string[]): PilotCommand {
  try {
    const { values, tokens } = parseArgs({ args, strict: true, allowPositionals: false, tokens: true, options: {
      help: { type: "boolean" }, apply: { type: "boolean" }, "dry-run": { type: "boolean" }, "preview-retention": { type: "boolean" },
      "org-id": { type: "string" }, source: { type: "string" }, allowance: { type: "string" },
      "attachment-window-seconds": { type: "string" }, "excess-mode": { type: "string" }, categories: { type: "string" },
      "operator-reference": { type: "string" },
    } })
    const names = tokens.flatMap((token) => token.kind === "option" ? [token.name] : [])
    if (new Set(names).size !== names.length) throw new Error()
    if (values.help) {
      if (args.length !== 1) throw new Error()
      return { mode: "help" }
    }
    if (values["preview-retention"]) {
      if (names.some((name) => !["preview-retention", "org-id"].includes(name))) throw new Error()
      return { mode: "preview-retention", organizationId: typeId.schema("organization").parse(values["org-id"]) }
    }
    if (values.apply && values["dry-run"]) throw new Error()
    const integer = (value: string | undefined) => {
      if (value === undefined || !/^(?:0|[1-9][0-9]*)$/.test(value)) throw new Error()
      return Number(value)
    }
    return { mode: values.apply ? "apply" : "dry-run", config: validatePilotConfig({
      organizationId: values["org-id"], source: values.source, allowance: integer(values.allowance),
      attachmentWindowSeconds: integer(values["attachment-window-seconds"]), excessMode: values["excess-mode"],
      ...(values.categories === undefined ? {} : { categories: values.categories.split(",") }),
      ...(values["operator-reference"] === undefined ? {} : { operatorReference: values["operator-reference"] }),
    }) }
  } catch { throw new AuditPilotError("audit_pilot_invalid_arguments") }
}

export const AUDIT_PILOT_HELP = `Manual PILOT initialization; no HTTP endpoint or scheduled work.
Run from ee/apps/den-api:
  pnpm exec tsx --conditions=development scripts/audit-pilot.ts --help
  pnpm exec tsx --conditions=development scripts/audit-pilot.ts --org-id <org_id> --source <cloud|operator> --allowance <operations> --attachment-window-seconds <1..86400> --excess-mode <mode> [--categories <csv>] [--operator-reference <nonsecret-reference>] [--apply]
  pnpm exec tsx --conditions=development scripts/audit-pilot.ts --org-id <org_id> --preview-retention

Default is --dry-run: verify the existing organization and absence of policy,
then print only allowlisted configuration/status. No writes. --apply explicitly
inserts a NEW enabled policy at revision 1 with its lifecycle event atomically.
Every existing policy (including disabled/future policies) is rejected unchanged.
No updates, downgrade, grace period, legacy backfill, or fabricated snapshots.
Uses the existing Den environment and configured database/operator credentials.
No new secrets; --operator-reference is optional, nonsecret, self-reported context,
never proof of a user identity. Actor is the system operator script, not a user.
No raw credentials, environment, database URL, or database errors are printed.

All five configuration options are required for initialization. Cloud supports
only delete_oldest; operator supports keep_all or delete_oldest. paid_overage,
prices and currency are unsupported. Allowance is retained OPERATION capacity:
one operation may contain many requests/events; requests and bytes are not units.
No retention days are guaranteed. keep_all thresholds are not hard storage limits.
delete_oldest is a declaration of intended future oldest-eligible whole-operation
retention, PREVIEW ONLY in this pilot: no deletion, cleanup worker or billing.
Any destructive implementation needs separate rollout; this CLI cannot activate it.

Categories default to change,security,execution,access,request,lifecycle.
Configurable categories: change,security,execution,access,read,request,lifecycle.
lifecycle is ALWAYS included, even when omitted from --categories.
Coverage is limited to implemented provider configuration and audit-read emitters;
category names do not promise all security, execution or read activity is captured.
Global DEN_AUDIT_CAPTURE_ENABLED and DEN_AUDIT_VISIBILITY_ENABLED default false
and are never changed. Capture controls traffic, not this direct policy event.
Policy enabled is organization opt-in, NOT entitlement. Source cloud/operator
only describes storage policy provenance; neither source grants availability.
Traffic also requires an Enterprise plan or explicit installation entitlement
DEN_AUDIT_SELF_HOSTED_ENABLED=true (default false). Single-org mode and disabled
legacy plan gating do not grant audit availability. No billing request is made.
Admins may toggle existing policies, but cannot initialize capacity or categories.
The policy event starts captureStartedAt; it does not imply traffic flags are on.

--preview-retention is a separate read-only mode using the stored policy, not
new settings; it cannot be combined with --apply or configuration options.
Reads a coherent state/policy/operation snapshot under a state share lock, with
at most 10000 operations. Larger/inconsistent snapshots fail explicitly as
incomplete. At most 1000 candidates are returned, with selectionComplete and
remainingEligibleDeletions. The digest/confirmation is informational only.
No job/delivery protection integration exists yet; unknown operation kinds fail
closed. Legacy rows are excluded, unchanged and not counted retroactively.
On an uncertain database/commit failure, inspect policy/history before retrying.
`

export function pilotConfigSummary(input: PilotConfig, flags: PilotFlags, mode: "dry-run" | "apply") {
  const config = validatePilotConfig(input)
  return {
    mode, organizationId: config.organizationId, source: config.source, enabled: true, revision: 1,
    allowance: config.allowance, capacityUnit: "retained_operation", excessMode: config.excessMode,
    attachmentWindowSeconds: config.attachmentWindowSeconds, categories: [...config.categories],
    actor: { type: "system", id: pilotActorId(config), operatorReferenceIsSelfReported: config.operatorReference !== undefined },
    effectiveAt: "initialization_clock_now", captureStartedAt: "policy_event_recording_time",
    auditCaptureEnabled: flags.auditCaptureEnabled === true, auditVisibilityEnabled: flags.auditVisibilityEnabled === true,
    policyEventBypassesTrafficFlag: true, coverage: "partial_provider_configuration_and_audit_access",
    billing: "disabled", cleanup: "preview_only", deletionEnabled: false, scheduledWork: false,
    legacy: "untouched", guaranteedRetentionDays: null,
  }
}

function pilotActorId(config: PilotConfig) {
  return config.operatorReference ? `${PILOT_SYSTEM_ACTOR}:${config.operatorReference}` : PILOT_SYSTEM_ACTOR
}

async function lockOrganization(tx: AuditTx, organizationId: string, mode: "update" | "share") {
  const [organization] = await tx.select({ id: OrganizationTable.id }).from(OrganizationTable)
    .where(eq(OrganizationTable.id, normalizeDenTypeId("organization", organizationId))).limit(1).for(mode)
  if (!organization) throw new AuditPilotError("audit_pilot_organization_not_found")
}

export async function initializeAuditPilot(database: AuditDatabase, input: PilotConfig, apply = false) {
  const config = validatePilotConfig(input)
  const organizationId = normalizeDenTypeId("organization", config.organizationId)
  return database.transaction(async (tx) => {
    await lockOrganization(tx, organizationId, apply ? "update" : "share")
    if (apply) await tx.insert(AuditStateTable).values({ organization_id: organizationId })
      .onDuplicateKeyUpdate({ set: { organization_id: sql`${AuditStateTable.organization_id}` } })
    const [state] = await tx.select().from(AuditStateTable).where(eq(AuditStateTable.organization_id, organizationId)).limit(1).for(apply ? "update" : "share")
    const [existing] = await tx.select({ revision: AuditPolicyTable.revision }).from(AuditPolicyTable)
      .where(eq(AuditPolicyTable.organization_id, organizationId)).limit(1).for(apply ? "update" : "share")
    if (existing) throw new AuditPilotError("audit_pilot_policy_exists")
    if (state && (state.last_sequence !== 0 || state.retained_operations !== 0 || state.event_count !== 0 || state.logical_bytes !== 0)) throw new AuditPilotError("audit_pilot_storage_inconsistent")
    if (!apply) return { status: "dry_run", organizationExists: true, policyExists: false, initialized: false }
    if (!state) throw new AuditPilotError("audit_pilot_storage_inconsistent")
    const now = new Date()
    const policy: AuditPolicy = {
      organizationId, revision: 1, source: config.source, enabled: true, categories: config.categories,
      allowance: config.allowance, excessMode: config.excessMode, effectiveAt: now.toISOString(),
      captureStartedAt: null, attachmentWindowSeconds: config.attachmentWindowSeconds,
    }
    await tx.insert(AuditPolicyTable).values({
      organization_id: organizationId, revision: policy.revision, source: policy.source, enabled: policy.enabled,
      categories: policy.categories, allowance: policy.allowance, excess_mode: policy.excessMode,
      effective_at: now, capture_started_at: null, attachment_window_seconds: policy.attachmentWindowSeconds,
    })
    const after = {
      organizationId, revision: policy.revision, source: policy.source, enabled: policy.enabled,
      categories: [...policy.categories], allowance: policy.allowance, excessMode: policy.excessMode,
      effectiveAt: policy.effectiveAt, attachmentWindowSeconds: policy.attachmentWindowSeconds,
    }
    const event = await appendAuditEvent(tx, {
      context: {
        organizationId, actor: { type: "system", id: pilotActorId(config) }, principalKey: `system:${pilotActorId(config)}`,
        origin: "platform_admin", originTrust: "reported", requestId: null, kind: "audit.policy", scope: organizationId,
      },
      policy,
      event: {
        action: "audit.policy.enabled", category: "lifecycle", outcome: "succeeded",
        resources: [{ type: "audit_policy", id: organizationId, relationship: "target" }, { type: "organization", id: organizationId, relationship: "parent" }],
        changes: { before: null, after, changedFields: Object.keys(after) },
      },
    })
    if (!event) throw new AuditPilotError("audit_pilot_storage_inconsistent")
    return { status: "initialized", organizationExists: true, policyExists: true, initialized: true, revision: 1,
      effectiveAt: policy.effectiveAt, captureStartedAt: event.recordedAt, eventId: event.id, operationId: event.operationId }
  })
}

export async function previewPilotRetention(database: AuditDatabase, inputOrganizationId: string) {
  const parsed = typeId.schema("organization").safeParse(inputOrganizationId)
  if (!parsed.success) throw new AuditPilotError("audit_pilot_invalid_arguments")
  const organizationId = normalizeDenTypeId("organization", parsed.data)
  return database.transaction(async (tx) => {
    await lockOrganization(tx, organizationId, "share")
    const [state] = await tx.select({ retainedOperations: AuditStateTable.retained_operations }).from(AuditStateTable)
      .where(eq(AuditStateTable.organization_id, organizationId)).limit(1).for("share")
    const [policy] = await tx.select({ revision: AuditPolicyTable.revision, allowance: AuditPolicyTable.allowance, excessMode: AuditPolicyTable.excess_mode, source: AuditPolicyTable.source })
      .from(AuditPolicyTable).where(eq(AuditPolicyTable.organization_id, organizationId)).limit(1).for("share")
    if (!policy) throw new AuditPilotError("audit_pilot_policy_missing")
    if (policy.excessMode === "paid_overage" || policy.source === "cloud" && policy.excessMode !== "delete_oldest") throw new AuditPilotError("audit_pilot_retention_unsupported_policy")
    if (!state || !Number.isSafeInteger(state.retainedOperations) || state.retainedOperations < 0 || state.retainedOperations > MAX_AUDIT_RETENTION_OPERATIONS) throw new AuditPilotError("audit_pilot_retention_incomplete_snapshot")
    const retained = and(eq(AuditOperationTable.organization_id, organizationId), eq(AuditOperationTable.retention_state, "retained"))
    const [count] = await tx.select({ value: sql<number>`count(*)`.mapWith(Number) }).from(AuditOperationTable).where(retained)
    if (!count || count.value !== state.retainedOperations) throw new AuditPilotError("audit_pilot_retention_incomplete_snapshot")
    const rows = await tx.select({ id: AuditOperationTable.id, organizationId: AuditOperationTable.organization_id,
      firstRecordedAt: AuditOperationTable.first_recorded_at, outcome: AuditOperationTable.outcome,
      attachmentExpiresAt: AuditOperationTable.attachment_expires_at, kind: AuditOperationTable.kind,
    }).from(AuditOperationTable).where(retained).orderBy(asc(AuditOperationTable.first_recorded_at), asc(AuditOperationTable.id)).limit(MAX_AUDIT_RETENTION_OPERATIONS).for("share")
    if (rows.length !== state.retainedOperations || rows.some((row) => !["provider.configuration", "audit.access", "audit.policy"].includes(row.kind))) throw new AuditPilotError("audit_pilot_retention_incomplete_snapshot")
    const preview = previewAuditRetention({
      organizationId, now: new Date().toISOString(),
      policy: { revision: policy.revision, allowance: policy.allowance, excessMode: policy.excessMode, maxAgeMs: null },
      installationMaximumOperations: null, retainedOperations: state.retainedOperations, maxCandidates: MAX_AUDIT_RETENTION_CANDIDATES,
      operations: rows.map((row) => ({ id: row.id, organizationId: row.organizationId, firstRecordedAt: row.firstRecordedAt.toISOString(), outcome: row.outcome,
        attachmentExpiresAt: row.attachmentExpiresAt.toISOString(), trustedJobPending: false, deliveryProtectedUntil: null })),
    })
    return { preview, confirmation: { organizationId, policyRevision: preview.policyRevision, snapshotDigest: preview.snapshotDigest },
      confirmationIsInformationalOnly: true, protections: "stored_outcome_and_attachment_window_only_no_job_or_delivery_integration", legacy: "excluded_untouched" }
  })
}
