import { z } from "zod"

export const clientFailureComponentSchema = z.enum(["engine", "local_server", "mcp_connection", "updater", "den_transport"])
export const clientFailurePhaseSchema = z.enum(["start", "run", "connect", "auth", "check", "download", "install", "request"])
export const clientFailureReasonSchema = z.enum([
  "exit_nonzero", "signal", "timeout", "dns", "certificate", "connection_refused", "offline",
  "server_error", "unauthorized", "invalid_response", "checksum", "disk", "permission", "unknown",
])
const phases = {
  engine: ["start", "run"],
  local_server: ["start", "run"],
  mcp_connection: ["connect", "auth"],
  updater: ["check", "download", "install"],
  den_transport: ["request"],
}
export const clientFailureReportSchema = z.strictObject({
  schemaVersion: z.literal(1),
  reportId: z.string().uuid(),
  occurredAt: z.string().datetime(),
  component: clientFailureComponentSchema,
  phase: clientFailurePhaseSchema,
  reason: clientFailureReasonSchema,
  appVersion: z.string().max(64).regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]{1,40})?$/),
  platform: z.enum(["darwin", "win32", "linux"]),
  arch: z.enum(["x64", "arm64", "ia32", "arm", "riscv64", "ppc64", "s390x"]),
  exitCode: z.number().int().min(-255).max(255).optional(),
  httpStatus: z.number().int().min(100).max(599).optional(),
  count: z.number().int().min(1).max(1000),
}).superRefine((report, ctx) => {
  if (!phases[report.component].includes(report.phase)) {
    ctx.addIssue({ code: "custom", path: ["phase"], message: "Invalid phase for component" })
  }
}).meta({ ref: "ClientFailureReport" })
export type ClientFailureReport = z.infer<typeof clientFailureReportSchema>
export const clientFailureBatchSchema = z.strictObject({ reports: z.array(clientFailureReportSchema).min(1).max(50) })

const statistics = z.strictObject({
  reports: z.number().int().nonnegative(),
  failures: z.number().int().nonnegative(),
  organizations: z.number().int().nonnegative(),
  latestOccurrence: z.string().datetime(),
})
export const clientFailureSummarySchema = z.strictObject({
  days: z.number().int().min(1).max(90),
  components: z.array(statistics.extend({ component: clientFailureComponentSchema, reason: clientFailureReasonSchema })),
  versions: z.array(statistics.extend({ appVersion: z.string() })),
  latest: z.array(clientFailureReportSchema.safeExtend({ organizationId: z.string(), receivedAt: z.string().datetime() })).max(100),
}).meta({ ref: "ClientFailureSummary" })
export type ClientFailureSummary = z.infer<typeof clientFailureSummarySchema>
