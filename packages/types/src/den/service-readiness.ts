import { z } from "zod"

/** Deployment diagnostics contain fixed facts, never endpoints, credentials or provider errors. */
export const serviceIdSchema = z.enum(["database", "gateway", "headlessRunner", "workbot", "email"])
export type ServiceId = z.infer<typeof serviceIdSchema>
export const serviceReadinessStateSchema = z.enum(["ready", "not_configured", "misconfigured", "unreachable", "unknown"])
export type ServiceReadinessState = z.infer<typeof serviceReadinessStateSchema>
export const serviceReadinessReasonSchema = z.enum([
  "not_checked", "not_configured", "missing_configuration", "invalid_configuration",
  "health_verified", "database_verified", "authentication_failed", "unexpected_response",
  "request_failed", "timeout", "dependency_unavailable", "configuration_only",
  "incompatible_service", "email_verified", "email_key_verified", "email_sender_unverified",
  "resume_misconfigured",
])
export type ServiceReadinessReason = z.infer<typeof serviceReadinessReasonSchema>

/** Fixed sub-facts shown under a service. Codes only, never values. */
export const serviceNoteSchema = z.enum([
  "resume_ready", "resume_not_configured", "resume_misconfigured",
  "email_smtp", "email_resend",
])
export type ServiceNote = z.infer<typeof serviceNoteSchema>

export const deploymentServiceStatusSchema = z.strictObject({
  id: serviceIdSchema,
  required: z.boolean(),
  configured: z.boolean(),
  state: serviceReadinessStateSchema,
  reason: serviceReadinessReasonSchema,
  /** Constant setting names only; values are never part of this contract. */
  missingSettings: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,95}$/)).max(16),
  dependencies: z.array(serviceIdSchema).max(4),
  notes: z.array(serviceNoteSchema).max(4),
  /** How long the last live check took; null when no network or database check ran. */
  durationMs: z.number().int().nonnegative().nullable(),
  checkedAt: z.string().datetime().nullable(),
  lastSuccessAt: z.string().datetime().nullable(),
  stale: z.boolean(),
}).meta({ ref: "DeploymentServiceStatus" })
export type DeploymentServiceStatus = z.infer<typeof deploymentServiceStatusSchema>

/** The Den replica that answered. Per process, never cached across replicas. */
export const denServerFactsSchema = z.strictObject({
  version: z.string().min(1).max(64),
  startedAt: z.string().datetime(),
  /** Process start until the HTTP server accepted connections. */
  startupMs: z.number().int().nonnegative().nullable(),
}).meta({ ref: "DenServerFacts" })
export type DenServerFacts = z.infer<typeof denServerFactsSchema>

export const deploymentServiceReadinessSchema = z.strictObject({
  version: z.literal(2),
  checkedAt: z.string().datetime().nullable(),
  checking: z.boolean(),
  server: denServerFactsSchema.nullable(),
  services: z.array(deploymentServiceStatusSchema).max(5),
}).meta({ ref: "DeploymentServiceReadiness" })
export type DeploymentServiceReadiness = z.infer<typeof deploymentServiceReadinessSchema>

/** Organization consumers cannot see deployment settings, origins or another member's access. */
export const organizationServiceReadinessSchema = z.strictObject({
  version: z.literal(2),
  checkedAt: z.string().datetime().nullable(),
  checking: z.boolean(),
  services: z.array(deploymentServiceStatusSchema.omit({ missingSettings: true, required: true, notes: true, durationMs: true })).max(5),
}).meta({ ref: "OrganizationServiceReadiness" })
export type OrganizationServiceReadiness = z.infer<typeof organizationServiceReadinessSchema>

export const SERVICE_LABELS: Record<ServiceId, string> = {
  database: "Database", gateway: "AI Gateway", headlessRunner: "Headless runner", workbot: "Workbot", email: "Email",
}
export const SERVICE_SETUP_HINTS: Record<ServiceId, string> = {
  database: "Configure Den's database connection. If Den cannot start, use the deployment logs and existing readiness probe.",
  gateway: "Deploy the AI Gateway and configure GATEWAY_ENABLED, GATEWAY_PROXY_BASE_URL and GATEWAY_PUBLIC_BASE_URL on Den. Model provider credentials are configured separately.",
  headlessRunner: "Deploy a headless runner with a model endpoint and persistent storage. Set DEN_HEADLESS_RUNNER_URL and DEN_HEADLESS_RUNNER_TOKEN on Den; the token must match the runner's HEADLESS_API_TOKEN. For resumable answers also set DEN_HEADLESS_RUNNER_CALLBACK_TOKEN on Den and HEADLESS_DEN_API_URL, HEADLESS_DEN_CALLBACK_TOKEN and HEADLESS_GRANT_KEY on the runner.",
  workbot: "Deploy Workbot and set DEN_WORKBOT_URL on Den. Configure Workbot's Den origin, runner connection and session-encryption secret separately.",
  email: "Choose SMTP (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS) or Resend (RESEND_API_KEY) and configure EMAIL_FROM.",
}
export const SERVICE_STATE_LABELS: Record<ServiceReadinessState, string> = {
  ready: "Ready", not_configured: "Not set up", misconfigured: "Misconfigured", unreachable: "Unreachable", unknown: "Couldn't verify",
}
export const SERVICE_REASON_LABELS: Record<ServiceReadinessReason, string> = {
  not_checked: "Not checked yet.",
  not_configured: "Optional service. Set it up when you need it.",
  missing_configuration: "Ask the deployment administrator to complete the missing settings.",
  invalid_configuration: "Ask the deployment administrator to correct the service settings.",
  health_verified: "The service answered its health check.",
  database_verified: "A database query succeeded.",
  authentication_failed: "The service rejected the credentials. Ask the deployment administrator to check them.",
  unexpected_response: "The service did not return a supported health response.",
  request_failed: "The service could not be reached. Ask the deployment administrator to check the connection.",
  timeout: "The service did not answer in time. Try checking again.",
  dependency_unavailable: "A required service is not set up or could not be verified.",
  configuration_only: "Settings are present, but a live check is not supported.",
  incompatible_service: "The configured address does not identify a compatible service.",
  email_verified: "Signed in to the mail service. For Resend, the EMAIL_FROM domain is verified. No message was sent.",
  email_key_verified: "The mail service accepted the key. This key can only send, so the sender domain was not checked. No message was sent.",
  email_sender_unverified: "The mail service accepted the key, but the EMAIL_FROM domain is not verified there.",
  resume_misconfigured: "Resumable answers are partly set up. Ask the deployment administrator to complete the callback settings.",
}
export const SERVICE_NOTE_LABELS: Record<ServiceNote, string> = {
  resume_ready: "Resumable answers: callback settings match",
  resume_not_configured: "Resumable answers: not set up",
  resume_misconfigured: "Resumable answers: callback settings incomplete",
  email_smtp: "SMTP",
  email_resend: "Resend",
}
