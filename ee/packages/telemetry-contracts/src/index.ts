import { z } from "zod"

/** Wire contract for telemetry ingestion and analytics. Field names, bounds,
 * and character sets are API surface consumed by the desktop app, workers,
 * and den-web — change them only with a coordinated client migration.
 *
 * This package is the client-safe half of @openwork-ee/telemetry: it must not
 * import den-db, node builtins, or anything else that cannot run in a browser
 * bundle. It ships TypeScript source (no build step); browser apps transpile
 * it and the server telemetry package bundles it. */

export const TELEMETRY_SOURCES = ["app", "worker"] as const
const sourceSet = new Set<string>(TELEMETRY_SOURCES)

export const DIMENSION_METADATA_MAX_BYTES = 4096

export function isKnownTelemetrySource(source: string | null | undefined): source is (typeof TELEMETRY_SOURCES)[number] {
  return typeof source === "string" && sourceSet.has(source)
}

/** Sources outside the allowlist collapse to "unknown" for dimension rows. */
export function normalizeTelemetrySource(source: string | null | undefined): string {
  return isKnownTelemetrySource(source) ? source : "unknown"
}

export const dimensionTypeSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .transform((value) => value.toLowerCase())
  .refine((value) => /^[a-z][a-z0-9_.-]{0,63}$/.test(value), {
    message: "Dimension type must start with a lowercase letter and contain only lowercase letters, numbers, dots, underscores, or hyphens.",
  })

export const dimensionValueSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .refine((value) => /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,127}$/.test(value), {
    message: "Dimension value must contain only letters, numbers, dots, underscores, colons, slashes, or hyphens.",
  })

export const dimensionMetadataSchema = z
  .record(z.string(), z.unknown())
  .refine((value) => new TextEncoder().encode(JSON.stringify(value)).length <= DIMENSION_METADATA_MAX_BYTES, {
    message: "Dimension metadata is too large.",
  })

export const telemetryDimensionSchema = z.object({
  type: dimensionTypeSchema,
  value: dimensionValueSchema.optional(),
  label: z.string().trim().min(1).max(255),
  metadata: dimensionMetadataSchema.optional(),
})

export type TelemetryDimensionInput = z.infer<typeof telemetryDimensionSchema>

export const telemetryIngestEventSchema = z.object({
  type: z.string().min(1).max(64),
  timestamp: z.string().datetime(),
  source: z.string().max(32).optional(),
  sessionId: z.string().max(128).optional(),
  durationMs: z.number().int().min(0).max(86_400_000).optional(),
  success: z.boolean().optional(),
  dimensions: z.array(telemetryDimensionSchema).max(8).optional(),
})

export type TelemetryIngestEvent = z.infer<typeof telemetryIngestEventSchema>

export const telemetryIngestBatchSchema = z.object({
  events: z.array(telemetryIngestEventSchema).min(1).max(50),
})

export const telemetryDimensionsQuerySchema = z.object({
  type: dimensionTypeSchema,
})

export const telemetryAnalyticsQuerySchema = z
  .object({
    dimensionType: dimensionTypeSchema.optional(),
    dimensionValue: dimensionValueSchema.optional(),
  })
  .refine((value) => Boolean(value.dimensionType) === Boolean(value.dimensionValue), {
    message: "dimensionType and dimensionValue must be supplied together.",
  })

export const telemetryAdoptionResponseSchema = z.object({
  members: z.number(),
  pendingInvites: z.number(),
  activeMembers7d: z.number(),
  activeMembers30d: z.number(),
  weeklyTrend: z.array(z.number()),
}).meta({ ref: "TelemetryAdoptionResponse" })

export const telemetryAnalyticsWeekSchema = z.object({
  weekStart: z.string(),
  activeMembers: z.number(),
  sessions: z.number(),
  tasksCompleted: z.number(),
  tasksFailed: z.number(),
})

export const telemetryAnalyticsModelsSchema = z.object({
  usage30d: z.array(z.object({
    id: z.string(),
    label: z.string(),
    sessions: z.number(),
  })),
  selection30d: z.object({
    default: z.number(),
    manual: z.number(),
  }),
})

export const telemetryAnalyticsResponseSchema = z.object({
  members: z.number(),
  pendingInvites: z.number(),
  activeMembers7d: z.number(),
  activeMembers30d: z.number(),
  sessions7d: z.number(),
  sessions30d: z.number(),
  tasksCompleted7d: z.number(),
  tasksFailed7d: z.number(),
  tasksCompleted30d: z.number(),
  tasksFailed30d: z.number(),
  avgTaskDurationMs30d: z.number().nullable(),
  weekly: z.array(telemetryAnalyticsWeekSchema),
  models: telemetryAnalyticsModelsSchema,
}).meta({ ref: "TelemetryAnalyticsResponse" })

export const telemetryDimensionListResponseSchema = z.object({
  items: z.array(z.object({
    type: z.string(),
    value: z.string(),
    label: z.string(),
    sessionCount: z.number(),
    lastSeenAt: z.string(),
  })),
}).meta({ ref: "TelemetryDimensionListResponse" })

export type TelemetryAdoptionResponse = z.infer<typeof telemetryAdoptionResponseSchema>
export type TelemetryAnalyticsWeek = z.infer<typeof telemetryAnalyticsWeekSchema>
export type TelemetryAnalyticsModels = z.infer<typeof telemetryAnalyticsModelsSchema>
export type TelemetryAnalyticsResponse = z.infer<typeof telemetryAnalyticsResponseSchema>
export type TelemetryDimensionListResponse = z.infer<typeof telemetryDimensionListResponseSchema>
export type TelemetryDimensionListItem = TelemetryDimensionListResponse["items"][number]
export * from "./models-analytics"
