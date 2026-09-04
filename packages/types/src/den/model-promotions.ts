import { z } from "zod"

const money = z.number().int().min(1).max(1_000_000_000_000)
export const modelPromotionTermsSchema = z.object({
  displayName: z.string().trim().min(1).max(80),
  alias: z.string().regex(/^[a-z][a-z0-9-]{2,63}$/),
  upstreamModel: z.string().regex(/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/),
  provider: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(1000),
  stripePriceId: z.string().regex(/^price_[a-zA-Z0-9_]+$/),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  creditMicrousd: money,
  budgetMicrousd: money,
  capacity: z.number().int().min(1).max(10000),
  durationSeconds: z.number().int().min(60).max(31 * 86400),
  activationDays: z.number().int().min(1).max(30),
  newAccountsOnly: z.boolean(),
  maxInputBytes: z.number().int().min(1000).max(500000),
  maxOutputTokens: z.number().int().min(128).max(32768),
  inputUsdPerMillion: z.number().positive().max(1000),
  outputUsdPerMillion: z.number().positive().max(5000),
  // Reserve room for provider/BYOK fees. These ceilings must cover the chosen route.
  feeReserveBps: z.number().int().min(1000).max(10000),
  requestsPerMinute: z.number().int().min(1).max(120),
}).strict().refine((v) => Date.parse(v.endsAt) > Date.parse(v.startsAt), "End must follow start")
  .refine((v) => v.creditMicrousd * v.capacity <= v.budgetMicrousd, "Budget must fund every advertised place")

export type ModelPromotionTerms = z.infer<typeof modelPromotionTermsSchema>
export const promotionStatusSchema = z.enum(["draft", "active", "paused", "stopped"])
export const promotionGrantStatusSchema = z.enum(["reserved", "available", "active", "expired", "exhausted", "revoked", "released"])
export const modelPromotionSchema = z.object({
  id: z.string(), slug: z.string(), version: z.number().int(),
  status: promotionStatusSchema, terms: modelPromotionTermsSchema,
  claimed: z.number(), spentMicrousd: z.number(), reservedMicrousd: z.number(),
})
export const modelPromotionGrantSchema = z.object({
  id: z.string(), campaignId: z.string(), status: promotionGrantStatusSchema,
  terms: modelPromotionTermsSchema, creditMicrousd: z.number(),
  spentMicrousd: z.number(), reservedMicrousd: z.number(),
  expiresAt: z.string().nullable(), activateBy: z.string().nullable(),
})
export const modelPromotionOffersSchema = z.object({
  offers: z.array(modelPromotionSchema), grants: z.array(modelPromotionGrantSchema),
})
