import { z } from "zod"

export const EGRESS_DIAGNOSTIC_RUN_HEADER = "x-openwork-diagnostic-run-id"
export const EGRESS_DIAGNOSTIC_STEP_HEADER = "x-openwork-diagnostic-step"
export const EGRESS_DIAGNOSTIC_SIGNATURE_HEADER = "x-openwork-diagnostic-signature"
export const EGRESS_DIAGNOSTIC_ID_HEADER = "x-openwork-diagnostic-id"

export const EGRESS_DIAGNOSTIC_STEP_IDS = [
  "reachability",
  "http-methods",
  "redirect",
  "oauth-discovery",
  "oauth-token",
  "mcp-handshake",
] as const

export const egressDiagnosticStepIdSchema = z.enum(EGRESS_DIAGNOSTIC_STEP_IDS)
export type EgressDiagnosticStepId = z.infer<typeof egressDiagnosticStepIdSchema>

export const egressDiagnosticStepStatusSchema = z.enum(["passed", "failed", "skipped"])
export type EgressDiagnosticStepStatus = z.infer<typeof egressDiagnosticStepStatusSchema>

export const egressDiagnosticCategorySchema = z.enum([
  "connectivity",
  "http",
  "oauth",
  "mcp",
])
export type EgressDiagnosticCategory = z.infer<typeof egressDiagnosticCategorySchema>

export const egressDiagnosticOwnerSchema = z.enum([
  "den-operator",
  "network-administrator",
  "openwork-support",
])
export type EgressDiagnosticOwner = z.infer<typeof egressDiagnosticOwnerSchema>

export const egressDiagnosticStepSchema = z.object({
  id: egressDiagnosticStepIdSchema,
  label: z.string().min(1).max(120),
  category: egressDiagnosticCategorySchema,
  status: egressDiagnosticStepStatusSchema,
  startedAt: z.string(),
  completedAt: z.string(),
  durationMs: z.number().int().nonnegative(),
  httpStatuses: z.array(z.number().int().min(100).max(599)).max(16),
  diagnosticIds: z.array(z.string().uuid()).max(16),
  code: z.string().min(1).max(120).nullable(),
  message: z.string().min(1).max(500),
  owner: egressDiagnosticOwnerSchema,
  action: z.string().min(1).max(500),
})
export type EgressDiagnosticStep = z.infer<typeof egressDiagnosticStepSchema>

export const egressDiagnosticRunSchema = z.object({
  runId: z.string().uuid(),
  targetOrigin: z.string().url(),
  supportUrl: z.string().url(),
  startedAt: z.string(),
  completedAt: z.string(),
  overallStatus: z.enum(["passed", "failed"]),
  highestPassingStep: egressDiagnosticStepIdSchema.nullable(),
  failedStep: egressDiagnosticStepIdSchema.nullable(),
  steps: z.array(egressDiagnosticStepSchema).length(EGRESS_DIAGNOSTIC_STEP_IDS.length),
})
export type EgressDiagnosticRun = z.infer<typeof egressDiagnosticRunSchema>

export const egressDiagnosticConfigurationSchema = z.object({
  available: z.boolean(),
  targetOrigin: z.string().url().nullable(),
  missingConfiguration: z.array(z.enum([
    "DEN_DIAGNOSTICS_ORIGIN",
    "DEN_DIAGNOSTICS_BEARER_TOKEN",
  ])).max(2),
})
export type EgressDiagnosticConfiguration = z.infer<typeof egressDiagnosticConfigurationSchema>
