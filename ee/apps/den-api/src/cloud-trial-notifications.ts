import { randomUUID } from "node:crypto"
import { and, eq, isNull, lte, or } from "@openwork-ee/den-db/drizzle"
import { AuthUserTable, MemberTable, OrgCloudTrialTable, OrganizationTable } from "@openwork-ee/den-db/schema"
import { db } from "./db.js"
import { env } from "./env.js"
import { appLogger } from "./observability/logger.js"
import { getOpenWorkWebAccess } from "./stripe-billing.js"
import { sendEmail } from "./utils/email/send-email.js"

const DAY_MS = 24 * 60 * 60 * 1000
const LEASE_MS = 10 * 60 * 1000

export async function sendDueCloudTrialNotifications() {
  const now = new Date()
  const due = await db.select().from(OrgCloudTrialTable).where(and(
    isNull(OrgCloudTrialTable.expired_sent_at),
    lte(OrgCloudTrialTable.expires_at, new Date(now.getTime() + DAY_MS)),
    or(isNull(OrgCloudTrialTable.ending_sent_at), lte(OrgCloudTrialTable.expires_at, now)),
    or(isNull(OrgCloudTrialTable.notification_lease_until), lte(OrgCloudTrialTable.notification_lease_until, now)),
  )).limit(20)
  for (const trial of due) {
    const token = randomUUID()
    await db.update(OrgCloudTrialTable).set({
      notification_lease_token: token,
      notification_lease_until: new Date(now.getTime() + LEASE_MS),
    }).where(and(
      eq(OrgCloudTrialTable.organization_id, trial.organization_id),
      isNull(OrgCloudTrialTable.expired_sent_at),
      or(isNull(OrgCloudTrialTable.ending_sent_at), lte(OrgCloudTrialTable.expires_at, now)),
      or(isNull(OrgCloudTrialTable.notification_lease_until), lte(OrgCloudTrialTable.notification_lease_until, now)),
    ))
    const [claimed] = await db.select().from(OrgCloudTrialTable).where(and(
      eq(OrgCloudTrialTable.organization_id, trial.organization_id),
      eq(OrgCloudTrialTable.notification_lease_token, token),
    )).limit(1)
    if (!claimed) continue
    try {
      const access = await getOpenWorkWebAccess(trial.organization_id)
      const recipients = await db.select({ email: AuthUserTable.email, name: OrganizationTable.name, userId: MemberTable.userId })
        .from(MemberTable)
        .innerJoin(AuthUserTable, eq(AuthUserTable.id, MemberTable.userId))
        .innerJoin(OrganizationTable, eq(OrganizationTable.id, MemberTable.organizationId))
        .where(and(
          eq(MemberTable.organizationId, trial.organization_id),
          or(eq(MemberTable.userId, trial.started_by_user_id), eq(MemberTable.role, "owner")),
          isNull(MemberTable.removedAt),
        )).limit(2)
      const recipient = recipients.find((entry) => entry.userId === trial.started_by_user_id) ?? recipients[0]
      const expired = claimed.expires_at.getTime() <= Date.now()
      const noNoticeNeeded = !recipient || access.accessSource === "subscription" || access.accessSource === "complimentary"
      if (!noNoticeNeeded) {
        await sendEmail({
          to: recipient.email,
          template: "cloudTrial",
          props: {
            phase: expired ? "expired" : "ending",
            organizationName: recipient.name,
            expiresAt: claimed.expires_at.toISOString(),
            workspaceUrl: `${env.webUrl}/dashboard/web`,
          },
        })
      }
      // The lease prevents concurrent delivery. Mark only after sending, so a
      // failed send can retry after restart. A crash after delivery may duplicate
      // an email; expiry enforcement never depends on the notification worker.
      await db.update(OrgCloudTrialTable).set({
        ...(expired || noNoticeNeeded ? { expired_sent_at: new Date() } : { ending_sent_at: new Date() }),
        notification_lease_token: null,
        notification_lease_until: null,
      }).where(and(eq(OrgCloudTrialTable.organization_id, trial.organization_id), eq(OrgCloudTrialTable.notification_lease_token, token)))
    } catch (error) {
      appLogger.error("Cloud trial reminder failed; retrying after lease expires", { component: "cloud_trial_notifications", error })
    }
  }
}

export function startCloudTrialNotificationLoop() {
  const configured = Number(process.env.OPENWORK_CLOUD_TRIAL_POLL_MS)
  const interval = Number.isFinite(configured) && configured >= 1000 ? configured : 60_000
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let cycle: Promise<void> | undefined
  const run = async () => {
    try {
      await sendDueCloudTrialNotifications()
    } catch (error) {
      appLogger.error("Cloud trial notification cycle failed", { component: "cloud_trial_notifications", error })
    } finally {
      if (!stopped) {
        timer = setTimeout(() => { cycle = run() }, interval)
        timer.unref()
      }
    }
  }
  cycle = run()
  return async () => {
    stopped = true
    if (timer) clearTimeout(timer)
    await cycle
  }
}
