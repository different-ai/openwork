import { createHash, randomBytes } from "node:crypto"
import { and, eq, gte, isNotNull, isNull, lte, notExists, sql } from "@openwork-ee/den-db/drizzle"
import {
  AuthUserTable,
  InvitationTable,
  LifecycleEmailTable,
  MemberTable,
  OrganizationTable,
  WorkspaceBootstrapTable,
  WorkspaceClaimTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils"
import { affectedRows } from "../core/db/affected-rows.js"
import { db } from "../db.js"
import { env } from "../env.js"
import { appLogger } from "../observability/logger.js"
import { captureException } from "../observability/runtime.js"
import { claimUrl } from "../routes/bootstrap/index.js"
import { sendEmail } from "../utils/email/send-email.js"
import {
  CLAIM_REMINDER_MIN_AGE_MS,
  CLAIM_REMINDER_MIN_REMAINING_MS,
  formatExpiryLabel,
  isClaimReminderDue,
  isTeamNudgeDue,
  LIFECYCLE_EMAIL_KINDS,
  normalizeEmailAddress,
  signUnsubscribeToken,
  TEAM_NUDGE_MAX_AGE_MS,
  TEAM_NUDGE_MIN_AGE_MS,
} from "./policy.js"

const logger = appLogger.child({ component: "lifecycle_emails" })
const BATCH_SIZE = 25
const DEFAULT_MCP_URL = "https://api.openworklabs.com/mcp/agent"
const MCP_DOCS_URL = "https://openworklabs.com/docs/start-here/connect-openwork-mcp"

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

function emailDeliveryConfigured() {
  return Boolean(env.email.from && (env.resend.apiKey || env.smtp.host)) || env.devMode
}

export function lifecycleUnsubscribeUrl(email: string) {
  const base = env.apiPublicUrl ?? env.betterAuthUrl
  const address = normalizeEmailAddress(email)
  const token = signUnsubscribeToken(address, env.betterAuthSecret)
  return `${base}/v1/email/unsubscribe?email=${encodeURIComponent(address)}&token=${encodeURIComponent(token)}`
}

/** Record an unsubscribe. Idempotent. */
export async function recordLifecycleUnsubscribe(email: string) {
  const address = normalizeEmailAddress(email)
  await db.insert(LifecycleEmailTable).ignore().values({
    kind: LIFECYCLE_EMAIL_KINDS.unsubscribe,
    subjectKey: address,
    recipient: address,
    status: "recorded",
  })
}

/** Insert the ledger row first; only the replica whose insert wins sends. */
async function reserve(kind: string, subjectKey: string, recipient: string) {
  const result = await db.insert(LifecycleEmailTable).ignore().values({ kind, subjectKey, recipient, status: "sending" })
  return affectedRows(result) > 0
}

async function settle(kind: string, subjectKey: string, outcome: { ok: true } | { ok: false; error: unknown }) {
  await db
    .update(LifecycleEmailTable)
    .set(outcome.ok
      ? { status: "sent", sentAt: new Date(), error: null }
      : { status: "failed", error: (outcome.error instanceof Error ? outcome.error.message : String(outcome.error)).slice(0, 255) })
    .where(and(eq(LifecycleEmailTable.kind, kind), eq(LifecycleEmailTable.subjectKey, subjectKey)))
}

function notUnsubscribed(emailColumn: typeof AuthUserTable.email | typeof WorkspaceBootstrapTable.ownerEmail) {
  return notExists(
    db.select({ one: sql`1` }).from(LifecycleEmailTable).where(and(
      eq(LifecycleEmailTable.kind, LIFECYCLE_EMAIL_KINDS.unsubscribe),
      eq(LifecycleEmailTable.subjectKey, sql`lower(${emailColumn})`),
    )),
  )
}

function notYetSent(kind: string, subjectColumn: typeof WorkspaceBootstrapTable.id | typeof OrganizationTable.id) {
  return notExists(
    db.select({ one: sql`1` }).from(LifecycleEmailTable).where(and(
      eq(LifecycleEmailTable.kind, kind),
      eq(LifecycleEmailTable.subjectKey, subjectColumn),
    )),
  )
}

/**
 * One reminder per provisional workspace whose person gave an email and has
 * not claimed it yet. A fresh owner claim link is minted at send time because
 * only hashes of earlier links are stored.
 */
async function sendClaimReminders(now: Date) {
  const kind = LIFECYCLE_EMAIL_KINDS.claimReminder
  const rows = await db
    .select({
      bootstrapId: WorkspaceBootstrapTable.id,
      organizationId: WorkspaceBootstrapTable.organizationId,
      organizationName: OrganizationTable.name,
      ownerEmail: WorkspaceBootstrapTable.ownerEmail,
      createdAt: WorkspaceBootstrapTable.createdAt,
      expiresAt: WorkspaceBootstrapTable.expiresAt,
    })
    .from(WorkspaceBootstrapTable)
    .innerJoin(OrganizationTable, eq(OrganizationTable.id, WorkspaceBootstrapTable.organizationId))
    .where(and(
      eq(WorkspaceBootstrapTable.status, "provisional"),
      isNull(WorkspaceBootstrapTable.claimedAt),
      isNotNull(WorkspaceBootstrapTable.ownerEmail),
      lte(WorkspaceBootstrapTable.createdAt, new Date(now.getTime() - CLAIM_REMINDER_MIN_AGE_MS)),
      gte(WorkspaceBootstrapTable.expiresAt, new Date(now.getTime() + CLAIM_REMINDER_MIN_REMAINING_MS)),
      notYetSent(kind, WorkspaceBootstrapTable.id),
      notUnsubscribed(WorkspaceBootstrapTable.ownerEmail),
    ))
    .limit(BATCH_SIZE)

  let sent = 0
  for (const row of rows) {
    const email = row.ownerEmail ? normalizeEmailAddress(row.ownerEmail) : ""
    if (!email || !isClaimReminderDue({ createdAt: row.createdAt, expiresAt: row.expiresAt, now })) continue
    if (!(await reserve(kind, row.bootstrapId, email))) continue

    try {
      const token = randomBytes(32).toString("base64url")
      await db.insert(WorkspaceClaimTable).values({
        id: createDenTypeId("workspaceClaim"),
        bootstrapId: row.bootstrapId,
        organizationId: row.organizationId,
        tokenHash: sha256(token),
        role: "owner",
        status: "pending",
        expiresAt: row.expiresAt,
      })
      await sendEmail({
        to: email,
        template: "claimReminder",
        props: {
          organizationName: row.organizationName,
          claimLink: claimUrl(token, { prefillEmail: email }),
          expiresAtLabel: formatExpiryLabel(row.expiresAt),
        },
      })
      await settle(kind, row.bootstrapId, { ok: true })
      sent += 1
    } catch (error) {
      await settle(kind, row.bootstrapId, { ok: false, error })
      logger.warn("claim reminder failed", { bootstrap_id: row.bootstrapId, error })
    }
  }
  return sent
}

/**
 * One nudge per organization whose owner is still alone a couple of days in:
 * invite teammates, or add the MCP gateway once as an org connector.
 */
async function sendTeamNudges(now: Date) {
  const kind = LIFECYCLE_EMAIL_KINDS.teamNudge
  const rows = await db
    .select({
      organizationId: OrganizationTable.id,
      organizationName: OrganizationTable.name,
      organizationCreatedAt: OrganizationTable.createdAt,
      ownerEmail: AuthUserTable.email,
      activeMemberCount: sql<number>`(select count(*) from ${MemberTable} as m where m.organization_id = ${OrganizationTable.id} and m.removed_at is null and m.is_setup_agent = false and m.user_id is not null)`,
      invitationCount: sql<number>`(select count(*) from ${InvitationTable} as i where i.organization_id = ${OrganizationTable.id})`,
    })
    .from(OrganizationTable)
    .innerJoin(MemberTable, and(
      eq(MemberTable.organizationId, OrganizationTable.id),
      sql`find_in_set('owner', ${MemberTable.role}) > 0`,
      isNull(MemberTable.removedAt),
      eq(MemberTable.isSetupAgent, false),
    ))
    .innerJoin(AuthUserTable, and(eq(AuthUserTable.id, MemberTable.userId), eq(AuthUserTable.emailVerified, true)))
    .where(and(
      gte(OrganizationTable.createdAt, new Date(now.getTime() - TEAM_NUDGE_MAX_AGE_MS)),
      lte(OrganizationTable.createdAt, new Date(now.getTime() - TEAM_NUDGE_MIN_AGE_MS)),
      // Provisional workspaces get the claim reminder instead.
      notExists(db.select({ one: sql`1` }).from(WorkspaceBootstrapTable).where(and(
        eq(WorkspaceBootstrapTable.organizationId, OrganizationTable.id),
        eq(WorkspaceBootstrapTable.status, "provisional"),
      ))),
      notYetSent(kind, OrganizationTable.id),
      notUnsubscribed(AuthUserTable.email),
    ))
    .limit(BATCH_SIZE)

  const mcpUrl = env.apiPublicUrl ? `${env.apiPublicUrl}/mcp/agent` : DEFAULT_MCP_URL
  let sent = 0
  for (const row of rows) {
    const email = normalizeEmailAddress(row.ownerEmail)
    const due = isTeamNudgeDue({
      organizationCreatedAt: row.organizationCreatedAt,
      now,
      activeMemberCount: Number(row.activeMemberCount),
      invitationCount: Number(row.invitationCount),
    })
    if (!email || !due) continue
    if (!(await reserve(kind, row.organizationId, email))) continue

    try {
      const unsubscribeLink = lifecycleUnsubscribeUrl(email)
      await sendEmail({
        to: email,
        template: "teamNudge",
        props: {
          organizationName: row.organizationName,
          membersLink: `${env.betterAuthUrl}/dashboard/members`,
          mcpUrl,
          mcpDocsLink: MCP_DOCS_URL,
          unsubscribeLink,
        },
        // RFC 8058 one-click unsubscribe; the endpoint accepts GET and POST.
        headers: {
          "List-Unsubscribe": `<${unsubscribeLink}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      })
      await settle(kind, row.organizationId, { ok: true })
      sent += 1
    } catch (error) {
      await settle(kind, row.organizationId, { ok: false, error })
      logger.warn("team nudge failed", { organization_id: row.organizationId, error })
    }
  }
  return sent
}

export async function runLifecycleEmailsOnce(now = new Date()) {
  const claimReminders = await sendClaimReminders(now)
  const teamNudges = await sendTeamNudges(now)
  if (claimReminders || teamNudges) {
    logger.info("lifecycle emails sent", { claim_reminders: claimReminders, team_nudges: teamNudges })
  }
  return { claimReminders, teamNudges }
}

export function startLifecycleEmailLoop(intervalMs = env.lifecycleEmails.intervalMs) {
  if (!env.lifecycleEmails.enabled || !Number.isFinite(intervalMs) || intervalMs <= 0) {
    return async () => undefined
  }
  if (!emailDeliveryConfigured()) {
    logger.warn("lifecycle emails enabled but email delivery is not configured; skipping")
    return async () => undefined
  }

  let running: Promise<void> | null = null
  const run = () => {
    if (running) return
    running = runLifecycleEmailsOnce()
      .then(() => undefined)
      .catch((error) => {
        logger.error("lifecycle email sweep failed", { error })
        captureException(error, { component: "lifecycle_emails" })
      })
      .finally(() => {
        running = null
      })
  }

  const timer = setInterval(run, intervalMs)
  timer.unref()
  run()
  return async () => {
    clearInterval(timer)
    await running
  }
}
