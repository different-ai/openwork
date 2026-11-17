import { z } from "zod"

export const operationalDiagnosticsConfigSchema = z.strictObject({
  enabled: z.boolean().default(false),
  output: z.enum(["stdout", "file"]).default("stdout"),
  intervalMinutes: z.number().int().min(5).max(1440).default(60),
})
export type OperationalDiagnosticsConfig = z.infer<typeof operationalDiagnosticsConfigSchema>

export const operationalComponentStateSchema = z.enum(["ok", "degraded", "down", "unknown"])
export type OperationalComponentState = z.infer<typeof operationalComponentStateSchema>

export const operationalDiagnosticSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  version: z.string().max(64).regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/),
  instanceKind: z.enum(["desktop", "den-api"]),
  deploymentKind: z.enum(["cloud", "self_hosted", "managed", "desktop"]).optional(),
  uptimeSeconds: z.enum(["0-299", "300-3599", "3600-86399", "86400+"]),
  snapshotTime: z.string().regex(/^20\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:00\.000Z$/),
  components: z.strictObject({
    database: operationalComponentStateSchema,
    migrations: operationalComponentStateSchema,
    worker: operationalComponentStateSchema,
    engine: operationalComponentStateSchema,
    localServer: operationalComponentStateSchema,
  }),
})
export type OperationalDiagnosticSnapshot = z.infer<typeof operationalDiagnosticSnapshotSchema>

export function bucketOperationalUptime(seconds: number): OperationalDiagnosticSnapshot["uptimeSeconds"] {
  if (seconds < 300) return "0-299"
  if (seconds < 3600) return "300-3599"
  if (seconds < 86400) return "3600-86399"
  return "86400+"
}

export function operationalSnapshotMinute(date: Date): string {
  return new Date(Math.floor(date.getTime() / 60_000) * 60_000).toISOString()
}
