import { z } from "zod"

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const freeAutoConversionStageSchema = z.enum(["all", "signed-in", "new-account", "subscribed", "unlinked"])
export const adminFreeAutoConversionsSchema = z.object({
  from: z.string().datetime(), to: z.string().datetime(), generatedAt: z.string().datetime(), attributionDays: z.literal(30),
  firstRecordedAt: z.string().datetime().nullable(),
  totals: z.object({ reachedLimit: count, signedIn: count, newAccounts: count, subscribed: count, unlinkedGuests: count }),
  daily: z.array(z.object({ date: z.string(), reachedLimit: count, signedIn: count, newAccounts: count, subscribed: count })).max(90),
  rows: z.array(z.object({
    id: z.string(), userId: z.string().nullable(), name: z.string().nullable(), email: z.string().nullable(),
    startedAsGuest: z.boolean(), exhaustedAt: z.string().datetime(), signedInAt: z.string().datetime().nullable(),
    signedUpAt: z.string().datetime().nullable(), subscribedAt: z.string().datetime().nullable(),
  })).max(50),
  page: z.object({ page: count, pageSize: z.literal(50), total: count, hasMore: z.boolean() }),
}).meta({ ref: "AdminFreeAutoConversions" })
export type AdminFreeAutoConversions = z.infer<typeof adminFreeAutoConversionsSchema>
