import { z } from "zod"
import { denServerFactsSchema, deploymentServiceReadinessSchema } from "@openwork/types/den/service-readiness"

/**
 * Settings › Diagnostics: one page and one endpoint for cloud, single-org and
 * self-hosted Den. Every section is either granted or locked for the caller;
 * locked sections stay present (DESIGN.md P4) and name the permission needed.
 * Never contains credentials, upstream bodies, URLs with secrets, or another
 * member's identity.
 */

// ── Desktop startup reports (desktop app → Den) ────────────────────────────

/** Steps measured from desktop process start. */
export const desktopStartupStepSchema = z.enum(["window", "engine", "signed_in", "org_tools"])
export type DesktopStartupStep = z.infer<typeof desktopStartupStepSchema>
export const DESKTOP_STARTUP_STEPS = desktopStartupStepSchema.options

export const desktopStartupFailureReasonSchema = z.enum([
  "certificate", "dns", "offline", "timeout", "connection_refused", "server_error",
  "signed_out", "session_expired", "engine_failed", "org_unavailable", "unknown",
])
export type DesktopStartupFailureReason = z.infer<typeof desktopStartupFailureReasonSchema>

export const desktopStartupPlatformSchema = z.enum(["darwin", "win32", "linux", "other"])
export type DesktopStartupPlatform = z.infer<typeof desktopStartupPlatformSchema>

const stepMs = z.number().int().nonnegative().max(3_600_000).nullable()

/** POST /v1/diagnostics/desktop-startup body. One report per app launch. */
export const desktopStartupReportSchema = z.strictObject({
  /** Random per launch; repeated sends of the same launch are idempotent. */
  attemptId: z.string().uuid(),
  appVersion: z.string().min(1).max(64).regex(/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/),
  platform: desktopStartupPlatformSchema,
  /** When the launch happened (a failed launch may be sent on a later launch). */
  observedAt: z.string().datetime(),
  success: z.boolean(),
  /** Milliseconds from process start until each step finished; null when not reached. */
  steps: z.strictObject({
    window: stepMs,
    engine: stepMs,
    signed_in: stepMs,
    org_tools: stepMs,
  }),
  failedStep: desktopStartupStepSchema.nullable(),
  reason: desktopStartupFailureReasonSchema.nullable(),
}).superRefine((report, ctx) => {
  if (report.success && (report.failedStep !== null || report.reason !== null)) {
    ctx.addIssue({ code: "custom", message: "A successful startup has no failed step or reason.", path: ["failedStep"] })
  }
  if (!report.success && (report.failedStep === null || report.reason === null)) {
    ctx.addIssue({ code: "custom", message: "A failed startup names its failed step and reason.", path: ["failedStep"] })
  }
}).meta({ ref: "DesktopStartupReport" })
export type DesktopStartupReport = z.infer<typeof desktopStartupReportSchema>

// ── Sections ───────────────────────────────────────────────────────────────

export const diagnosticsSectionIdSchema = z.enum(["desktop", "providers", "connectors", "installation", "network"])
export type DiagnosticsSectionId = z.infer<typeof diagnosticsSectionIdSchema>

/** A section the caller may not open. `permission` is the organization permission key that grants it. */
export const lockedDiagnosticsSectionSchema = z.strictObject({
  access: z.literal("locked"),
  permission: z.string().min(1).max(64),
})

export const desktopDiagnosticsSchema = z.strictObject({
  access: z.literal("granted"),
  windowHours: z.literal(24),
  startups: z.number().int().nonnegative(),
  connected: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  /** Distinct members who launched the app in the window. */
  people: z.number().int().nonnegative(),
  /** Median and 95th percentile of process start → org tools loaded, successful launches only. */
  typicalMs: z.number().int().nonnegative().nullable(),
  slowestMs: z.number().int().nonnegative().nullable(),
  /** Median time spent in each step (not cumulative), successful launches only. */
  steps: z.array(z.strictObject({ step: desktopStartupStepSchema, typicalMs: z.number().int().nonnegative().nullable() })).max(4),
  failures: z.array(z.strictObject({
    step: desktopStartupStepSchema,
    reason: desktopStartupFailureReasonSchema,
    count: z.number().int().positive(),
    people: z.number().int().positive(),
    lastSeenAt: z.string().datetime(),
  })).max(20),
  versions: z.array(z.strictObject({ version: z.string().max(64), startups: z.number().int().positive() })).max(10),
})
export type DesktopDiagnostics = z.infer<typeof desktopDiagnosticsSchema>

export const providerCheckStateSchema = z.enum([
  "ready", "key_rejected", "unreachable", "model_missing", "misconfigured",
  "member_credentials", "managed", "not_checked",
])
export type ProviderCheckState = z.infer<typeof providerCheckStateSchema>
export const providerCheckReasonSchema = z.enum([
  /** Listed models with the stored credential. */
  "models_listed",
  /** Credential accepted, but model access can't be listed without a request (e.g. Bedrock STS). */
  "key_accepted",
  /** This provider type has no check that avoids sending a model request. */
  "no_live_check",
  /** Each member signs in with their own account; Den never probes with a member's credential. */
  "member_sign_in",
  "endpoint_not_found", "network_error", "timeout", "configuration_error",
  "credential_missing", "sync_error", "managed_by_openwork", "not_checked_yet",
  /** The provider refused the stored credential (HTTP 401/403, or a stored refresh/client failure). */
  "credential_rejected",
  /** The stored credential's expiry has passed and it cannot be refreshed. */
  "credential_expired",
  /** The provider answered with a status other than success, rejection or not found (e.g. 429, 5xx). */
  "unexpected_response",
])
export type ProviderCheckReason = z.infer<typeof providerCheckReasonSchema>

export const providerCheckSchema = z.strictObject({
  /** Stable row id (gateway provider + credential set, legacy provider, or "openwork"). */
  id: z.string().min(1).max(160),
  source: z.enum(["gateway", "legacy", "openwork"]),
  /** Catalog provider id, e.g. "anthropic", "openai", "litellm", "amazon-bedrock". Used for the logo. */
  providerId: z.string().min(1).max(128),
  name: z.string().min(1).max(255),
  /** Credential set name when a provider has more than one. */
  credentialName: z.string().max(255).nullable(),
  state: providerCheckStateSchema,
  reason: providerCheckReasonSchema,
  httpStatus: z.number().int().min(100).max(599).nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  checkedAt: z.string().datetime().nullable(),
  lastSuccessAt: z.string().datetime().nullable(),
  models: z.strictObject({
    configured: z.number().int().nonnegative(),
    /** null when the endpoint was not listed. */
    served: z.number().int().nonnegative().nullable(),
    /** Configured model ids the endpoint does not serve. */
    missing: z.array(z.string().max(255)).max(20),
  }),
  members: z.strictObject({
    connected: z.number().int().nonnegative(),
    needsAttention: z.number().int().nonnegative(),
  }).nullable(),
})
export type ProviderCheck = z.infer<typeof providerCheckSchema>

export const providersDiagnosticsSchema = z.strictObject({
  access: z.literal("granted"),
  checkedAt: z.string().datetime().nullable(),
  checking: z.boolean(),
  items: z.array(providerCheckSchema).max(100),
})
export type ProvidersDiagnostics = z.infer<typeof providersDiagnosticsSchema>

export const connectorCheckStateSchema = z.enum(["ready", "attention", "off", "not_checked"])
export type ConnectorCheckState = z.infer<typeof connectorCheckStateSchema>
export const connectorCheckReasonSchema = z.enum([
  "slack_token_accepted", "slack_token_rejected", "slack_not_installed",
  "slack_assistant_off", "slack_runner_missing",
  "google_apis_enabled", "google_api_disabled", "google_sign_in_required",
  "not_checked_yet",
])
export type ConnectorCheckReason = z.infer<typeof connectorCheckReasonSchema>

export const connectorCheckSchema = z.strictObject({
  id: z.string().min(1).max(160),
  kind: z.enum(["slack_assistant", "google_workspace"]),
  name: z.string().min(1).max(255),
  state: connectorCheckStateSchema,
  reason: connectorCheckReasonSchema,
  checkedAt: z.string().datetime().nullable(),
  /** Slack: newest event received in the last 7 days. */
  lastEventAt: z.string().datetime().nullable(),
  /** Slack: answers completed in the last 24 hours. */
  completed24h: z.number().int().nonnegative().nullable(),
  /** Google: APIs the connector's permissions need, checked with the caller's own sign-in. */
  apis: z.array(z.strictObject({
    id: z.string().max(64),
    name: z.string().max(128),
    status: z.enum(["enabled", "disabled", "unknown"]),
  })).max(12),
})
export type ConnectorCheck = z.infer<typeof connectorCheckSchema>

export const connectorsDiagnosticsSchema = z.strictObject({
  access: z.literal("granted"),
  checkedAt: z.string().datetime().nullable(),
  items: z.array(connectorCheckSchema).max(100),
})
export type ConnectorsDiagnostics = z.infer<typeof connectorsDiagnosticsSchema>

export const installationDiagnosticsSchema = z.discriminatedUnion("access", [
  /** Self-hosted installation administrator (local allowlist), session or their API key. */
  z.strictObject({ access: z.literal("operator"), server: denServerFactsSchema, services: deploymentServiceReadinessSchema }),
  /** Hosted OpenWork Cloud: infrastructure is operated by OpenWork. */
  z.strictObject({ access: z.literal("managed") }),
  /** Self-hosted, but the caller is not an installation administrator. */
  z.strictObject({ access: z.literal("locked"), reason: z.literal("installation_admin_required") }),
])
export type InstallationDiagnostics = z.infer<typeof installationDiagnosticsSchema>

export const networkDiagnosticsSchema = z.strictObject({
  access: z.literal("granted"),
  /** egress_diagnostics.manage: may run the check and replace its token. */
  canRun: z.boolean(),
})

// ── Attention summary ──────────────────────────────────────────────────────

export const diagnosticsAttentionCodeSchema = z.enum([
  "provider_key_rejected", "provider_unreachable", "provider_model_missing", "provider_misconfigured",
  "desktop_startup_failures",
  "connector_slack_token_rejected", "connector_slack_not_installed", "connector_google_api_disabled",
  "service_misconfigured", "service_unreachable",
])
export type DiagnosticsAttentionCode = z.infer<typeof diagnosticsAttentionCodeSchema>

export const diagnosticsAttentionSchema = z.strictObject({
  section: diagnosticsSectionIdSchema,
  /** Row id inside the section (provider check id, connector id, service id, or failure step). */
  targetId: z.string().min(1).max(160),
  severity: z.enum(["warning", "error"]),
  code: diagnosticsAttentionCodeSchema,
  /** Display name of the thing that needs attention, e.g. "LiteLLM" or "Email". */
  subject: z.string().min(1).max(255),
  /** Optional count, e.g. failed startups or missing models. */
  count: z.number().int().nonnegative().nullable(),
  /** Optional detail code, e.g. the desktop failure reason or the first missing model id. */
  detail: z.string().max(255).nullable(),
})
export type DiagnosticsAttention = z.infer<typeof diagnosticsAttentionSchema>

export const orgDiagnosticsSchema = z.strictObject({
  version: z.literal(1),
  generatedAt: z.string().datetime(),
  deployment: z.enum(["cloud", "self_hosted"]),
  checking: z.boolean(),
  attention: z.array(diagnosticsAttentionSchema).max(200),
  desktop: z.discriminatedUnion("access", [desktopDiagnosticsSchema, lockedDiagnosticsSectionSchema]),
  providers: z.discriminatedUnion("access", [providersDiagnosticsSchema, lockedDiagnosticsSectionSchema]),
  connectors: z.discriminatedUnion("access", [connectorsDiagnosticsSchema, lockedDiagnosticsSectionSchema]),
  installation: installationDiagnosticsSchema,
  network: z.discriminatedUnion("access", [networkDiagnosticsSchema, lockedDiagnosticsSectionSchema]),
}).meta({ ref: "OrgDiagnostics" })
export type OrgDiagnostics = z.infer<typeof orgDiagnosticsSchema>

/** Permission keys per section. Installation authority is never an organization permission. */
export const DIAGNOSTICS_SECTION_PERMISSIONS = {
  desktop: "desktop_policies.view",
  providers: "gateway_providers.view",
  connectors: "connections.view",
  network: "egress_diagnostics.view",
} as const
