import { z } from "zod"

/**
 * Feature intros (DESIGN.md I1–I10): per member and organization, which intros a person has seen,
 * dismissed or acted on. Den web owns the intro registry (keys and versions); Den only stores state
 * (`GET /v1/me/feature-intros`, `POST /v1/me/feature-intros/events`).
 */
export const featureIntroEventTypeSchema = z.enum(["seen", "dismissed", "cta_clicked"])
export type FeatureIntroEventType = z.infer<typeof featureIntroEventTypeSchema>

/** Registry key, keyed by route and tab, e.g. "ai-gateway.limits". */
export const featureIntroKeySchema = z.string().min(1).max(120).regex(/^[a-z0-9-]+(\.[a-z0-9-]+)*$/)
export type FeatureIntroKey = z.infer<typeof featureIntroKeySchema>

export const featureIntroStateSchema = z.object({
  introKey: featureIntroKeySchema,
  /** Registry version the timestamps belong to; a newer version shows the intro again. */
  introVersion: z.number().int().min(1),
  /** ISO timestamps, null until the event happened for this version. */
  firstSeenAt: z.string().datetime().nullable(),
  lastSeenAt: z.string().datetime().nullable(),
  dismissedAt: z.string().datetime().nullable(),
  ctaClickedAt: z.string().datetime().nullable(),
})
export type FeatureIntroState = z.infer<typeof featureIntroStateSchema>

export const featureIntroListResponseSchema = z.object({ intros: z.array(featureIntroStateSchema) })
export type FeatureIntroListResponse = z.infer<typeof featureIntroListResponseSchema>

export const featureIntroEventRequestSchema = z.object({
  introKey: featureIntroKeySchema,
  introVersion: z.number().int().min(1),
  type: featureIntroEventTypeSchema,
})
export type FeatureIntroEventRequest = z.infer<typeof featureIntroEventRequestSchema>

export const featureIntroEventResponseSchema = z.object({ intro: featureIntroStateSchema })
export type FeatureIntroEventResponse = z.infer<typeof featureIntroEventResponseSchema>
