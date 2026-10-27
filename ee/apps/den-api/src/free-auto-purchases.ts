import type Stripe from "stripe"
import { and, eq, sql } from "@openwork-ee/den-db/drizzle"
import { FreeAutoPurchaseTable, MemberTable, OrgSubscriptionTable } from "@openwork-ee/den-db/schema"
import { db } from "./db.js"
import { appLogger } from "./observability/logger.js"

/** Called only with positive payment evidence read from Stripe, never an admin plan override or checkout creation. */
export async function recordFreeAutoPurchase(input: {
  subscription: Stripe.Subscription; row: typeof OrgSubscriptionTable.$inferSelect | null; paidAt: Date;
}) {
  try {
    const { subscription, row, paidAt } = input
    if (!row || row.stripe_subscription_id !== subscription.id || !row.created_by_org_membership_id) return
    // Enterprise is sales-led: never a self-serve Free Auto conversion.
    if (row.type === "enterprise") return
    const [member] = await db.select({ userId: MemberTable.userId }).from(MemberTable).where(and(
      eq(MemberTable.id, row.created_by_org_membership_id), eq(MemberTable.organizationId, row.organization_id))).limit(1)
    if (!member?.userId) return
    await db.insert(FreeAutoPurchaseTable).values({ subscription_id: subscription.id, user_id: member.userId,
      organization_id: row.organization_id, type: row.type, started_at: new Date(subscription.created * 1000), paid_at: paidAt })
      .onDuplicateKeyUpdate({ set: { paid_at: sql`least(${FreeAutoPurchaseTable.paid_at}, values(paid_at))` } })
  } catch { appLogger.warn("Free Auto purchase behavior could not be recorded.") }
}
