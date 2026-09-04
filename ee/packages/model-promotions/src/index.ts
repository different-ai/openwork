import { createHash, randomUUID } from "node:crypto"
import type { createDenDb } from "@openwork-ee/den-db"
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm"
import { AuthUserTable, MemberTable, OrgSubscriptionTable,
  ModelPromotionTable as Campaign, ModelPromotionGrantTable as Grant,
  ModelPromotionRequestTable as Request, ModelPromotionVisitTable as Visit,
  ModelPromotionAuditTable as Audit } from "@openwork-ee/den-db/schema"
import { modelPromotionTermsSchema, promotionStatusSchema, type ModelPromotionTerms } from "@openwork/types/den/model-promotions"
import { INFERENCE_MODEL_ALIASES } from "@openwork/types/den/inference"
import { z } from "zod"

type Db = ReturnType<typeof createDenDb>["db"]
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0]
type Query = Db | Transaction
type GrantRow = typeof Grant.$inferSelect
type CampaignRow = typeof Campaign.$inferSelect
export type PromotionIdentity = { userId: GrantRow["user_id"]; organizationId: GrantRow["organization_id"]; memberId: GrantRow["member_id"] }
export class PromotionError extends Error {
  constructor(readonly code: string, message: string, readonly status: 400 | 403 | 404 | 409 | 429 | 503 = 409) { super(message) }
}
const fail = (code: string, message: string, status?: ConstructorParameters<typeof PromotionError>[2]): never => { throw new PromotionError(code, message, status) }
export const promotionKeyHash = (value: string) => createHash("sha256").update(value).digest("hex")

function publicCampaign(row: CampaignRow) {
  return { id: row.id, slug: row.slug, version: row.version, status: promotionStatusSchema.parse(row.status), terms: row.terms,
    claimed: row.claimed, spentMicrousd: row.spent_microusd, reservedMicrousd: row.reserved_microusd }
}
function publicGrant(row: GrantRow, now = new Date()) {
  const expired = row.status === "active" && row.expires_at && row.expires_at <= now
    || row.status === "available" && row.activate_by && row.activate_by <= now
  return { id: row.id, campaignId: row.campaign_id, terms: row.terms,
    status: expired ? "expired" : row.status === "active" && row.spent_microusd >= row.credit_microusd ? "exhausted" : row.status,
    creditMicrousd: row.credit_microusd, spentMicrousd: row.spent_microusd, reservedMicrousd: row.reserved_microusd,
    expiresAt: row.expires_at?.toISOString() ?? null, activateBy: row.activate_by?.toISOString() ?? null }
}
async function audit(db: Query, campaignId: string, actorId: string, action: string, subjectId: string | null = null) {
  await db.insert(Audit).values({ id: randomUUID(), campaign_id: campaignId, actor_id: actorId, action, subject_id: subjectId })
}
async function lockedCampaign(db: Query, id: string) {
  const [row] = await db.select().from(Campaign).where(eq(Campaign.id, id)).for("update")
  if (!row) return fail("offer_not_found", "This offer is unavailable.", 404)
  return row
}
async function lockedGrant(db: Query, id: string) {
  const [row] = await db.select().from(Grant).where(eq(Grant.id, id)).for("update")
  if (!row) return fail("grant_not_found", "This promotional credit was not found.", 404)
  return row
}
function assertOwner(grant: GrantRow, identity: PromotionIdentity) {
  if (grant.user_id !== identity.userId || grant.member_id !== identity.memberId || grant.organization_id !== identity.organizationId)
    fail("grant_not_found", "This promotional credit was not found.", 404)
}
async function assertMember(db: Query, identity: PromotionIdentity) {
  const [member] = await db.select().from(MemberTable).where(and(eq(MemberTable.id, identity.memberId), eq(MemberTable.organizationId, identity.organizationId), eq(MemberTable.userId, identity.userId))).for("update")
  if (!member || member.removedAt) fail("membership_required", "Your workspace membership is no longer active.", 403)
}
async function assertSubscription(db: Query, grant: GrantRow) {
  const [subscription] = await db.select().from(OrgSubscriptionTable).where(and(eq(OrgSubscriptionTable.organization_id, grant.organization_id), eq(OrgSubscriptionTable.type, "inference"))).for("update")
  if (!subscription || subscription.stripe_subscription_id !== grant.stripe_subscription_id || subscription.status !== "active"
    || subscription.payment_failed || !subscription.current_period_end || subscription.current_period_end <= new Date() || !grant.paid_at)
    fail("paid_membership_required", "An active, paid OpenWork Models membership is required.", 403)
}

export function createPromotionStore(db: Db) {
  return {
    async create(input: { slug: string; terms: ModelPromotionTerms; key: string }, actor: string) {
      const terms = modelPromotionTermsSchema.parse(input.terms)
      if (Object.hasOwn(INFERENCE_MODEL_ALIASES, terms.alias)) fail("alias_in_use", "Choose a name that is not an existing membership model.")
      const id = randomUUID()
      await db.transaction(async (tx) => {
        await tx.insert(Campaign).values({ id, slug: z.string().regex(/^[a-z][a-z0-9-]{2,63}$/).parse(input.slug), alias: terms.alias, terms,
          encrypted_key: z.string().trim().min(16).max(1024).parse(input.key), key_fingerprint: promotionKeyHash(input.key.trim()) })
        await audit(tx, id, actor, "created")
      })
      return id
    },
    async update(id: string, terms: ModelPromotionTerms, actor: string) {
      await db.transaction(async (tx) => {
        const row = await lockedCampaign(tx, id)
        if (row.status !== "draft" || row.claimed > 0) fail("terms_locked", "Terms can be edited only before the first claim and while the offer is a draft. Create a new offer for revised terms.")
        const validated = modelPromotionTermsSchema.parse(terms)
        if (validated.alias !== row.alias) fail("alias_locked", "The model identifier cannot change. Create a new offer to rename it.")
        await tx.update(Campaign).set({ terms: validated, version: row.version + 1 }).where(eq(Campaign.id, id))
        await audit(tx, id, actor, "terms_updated")
      })
    },
    async changeStatus(id: string, status: string, actor: string, validate: (row: CampaignRow) => Promise<void>) {
      const next = promotionStatusSchema.parse(status)
      const [snapshot] = await db.select().from(Campaign).where(eq(Campaign.id, id))
      if (!snapshot) return fail("offer_not_found", "This offer is unavailable.", 404)
      if (next === "active") await validate(snapshot)
      await db.transaction(async (tx) => {
        const current = await lockedCampaign(tx, id)
        if (current.version !== snapshot.version || current.status !== snapshot.status) fail("offer_changed", "The offer changed. Reload and try again.")
        if (next === "draft" && current.claimed > 0) fail("terms_locked", "A claimed offer cannot become a draft.")
        await tx.update(Campaign).set({ status: next }).where(eq(Campaign.id, id))
        await audit(tx, id, actor, `status_${next}`)
      })
    },
    async adminList() {
      return (await db.select().from(Campaign).orderBy(desc(Campaign.created_at)).limit(100)).map(publicCampaign)
    },
    async adminDetail(id: string) {
      const [campaign] = await db.select().from(Campaign).where(eq(Campaign.id, id))
      if (!campaign) return fail("offer_not_found", "This offer is unavailable.", 404)
      return { campaign: publicCampaign(campaign),
        grants: (await db.select().from(Grant).where(eq(Grant.campaign_id, id)).orderBy(desc(Grant.created_at)).limit(500)).map((row) => publicGrant(row)),
        requests: await db.select({ id: Request.id, grantId: Request.grant_id, status: Request.status, reservedMicrousd: Request.reserved_microusd, costMicrousd: Request.cost_microusd, generationId: Request.generation_id, createdAt: Request.created_at }).from(Request).where(eq(Request.campaign_id, id)).orderBy(desc(Request.created_at)).limit(100),
        audit: await db.select().from(Audit).where(eq(Audit.campaign_id, id)).orderBy(desc(Audit.created_at)).limit(100) }
    },
    async publicOffer(slug: string) {
      const [row] = await db.select().from(Campaign).where(and(eq(Campaign.slug, slug), eq(Campaign.status, "active")))
      if (!row || Date.parse(row.terms.startsAt) > Date.now() || Date.parse(row.terms.endsAt) <= Date.now()) return fail("offer_unavailable", "This offer is not currently open.", 404)
      return publicCampaign(row)
    },
    async visit(slug: string) {
      const offer = await this.publicOffer(slug)
      const token = randomUUID()
      await db.insert(Visit).values({ token_hash: promotionKeyHash(token), campaign_id: offer.id })
      return token
    },
    async offers(identity: PromotionIdentity) {
      const offers = await this.adminList()
      const grants = await db.select().from(Grant).where(and(eq(Grant.user_id, identity.userId), eq(Grant.organization_id, identity.organizationId), eq(Grant.member_id, identity.memberId)))
      return { offers: offers.filter((v) => v.status === "active" && Date.parse(v.terms.startsAt) <= Date.now() && Date.parse(v.terms.endsAt) > Date.now()), grants: grants.map((v) => publicGrant(v)) }
    },
    async reserveClaim(id: string, version: number, identity: PromotionIdentity, visitToken?: string) {
      return db.transaction(async (tx) => {
        const row = await lockedCampaign(tx, id)
        const [existing] = await tx.select().from(Grant).where(and(eq(Grant.campaign_id, id), eq(Grant.user_id, identity.userId)))
        if (existing) { assertOwner(existing, identity); return existing }
        const now = new Date()
        if (row.status !== "active" || Date.parse(row.terms.startsAt) > now.getTime() || Date.parse(row.terms.endsAt) <= now.getTime()) fail("offer_unavailable", "This offer is not currently open.")
        if (row.version !== version) fail("terms_changed", "The offer terms changed. Review the current offer before continuing.")
        if (row.claimed >= row.terms.capacity) fail("offer_full", "All places for this offer have been claimed.")
        await assertMember(tx, identity)
        const [user] = await tx.select().from(AuthUserTable).where(eq(AuthUserTable.id, identity.userId))
        if (!user?.emailVerified) fail("verify_email", "Verify your email before claiming this offer.", 403)
        const [orgClaim] = await tx.select({ id: Grant.id }).from(Grant).where(and(eq(Grant.campaign_id, id), eq(Grant.organization_id, identity.organizationId)))
        if (orgClaim) fail("already_claimed", "This workspace has already claimed this offer.")
        if (row.terms.newAccountsOnly) {
          const [subscription] = await tx.select().from(OrgSubscriptionTable).where(and(eq(OrgSubscriptionTable.organization_id, identity.organizationId), eq(OrgSubscriptionTable.type, "inference")))
          if (subscription) fail("membership_exists", "This new-account offer requires a new OpenWork Models subscription.", 403)
          if (!visitToken) return fail("signup_required", "This offer requires a new account created from the offer page.", 403)
          const [visit] = await tx.select().from(Visit).where(eq(Visit.token_hash, promotionKeyHash(visitToken))).for("update")
          if (!visit || visit.campaign_id !== id || visit.claimed_by || visit.created_at > user.createdAt || now.getTime() - visit.created_at.getTime() > 86400000)
            fail("signup_required", "This offer requires a new account created from the offer page within 24 hours.", 403)
          await tx.update(Visit).set({ claimed_by: identity.userId }).where(eq(Visit.token_hash, visit.token_hash))
        }
        const grantId = randomUUID()
        await tx.insert(Grant).values({ id: grantId, campaign_id: id, user_id: identity.userId, organization_id: identity.organizationId, member_id: identity.memberId,
          status: "reserved", terms: row.terms, terms_version: row.version, credit_microusd: row.terms.creditMicrousd })
        await tx.update(Campaign).set({ claimed: row.claimed + 1 }).where(eq(Campaign.id, id))
        await audit(tx, id, identity.userId, "checkout_reserved", grantId)
        return lockedGrant(tx, grantId)
      })
    },
    async attachCheckout(id: string, sessionId: string) {
      await db.update(Grant).set({ stripe_session_id: sessionId }).where(and(eq(Grant.id, id), eq(Grant.status, "reserved")))
    },
    async findGrant(id: string) { return (await db.select().from(Grant).where(eq(Grant.id, id)))[0] ?? null },
    async paid(id: string, payment: { subscriptionId: string; invoiceId: string; sessionId: string }) {
      const snapshot = await this.findGrant(id)
      if (!snapshot) return
      await db.transaction(async (tx) => {
        await lockedCampaign(tx, snapshot.campaign_id)
        const grant = await lockedGrant(tx, id)
        if (grant.status !== "reserved" || grant.stripe_session_id !== payment.sessionId) return
        await tx.update(Grant).set({ status: "available", stripe_subscription_id: payment.subscriptionId, stripe_invoice_id: payment.invoiceId, paid_at: new Date(),
          activate_by: new Date(Date.now() + grant.terms.activationDays * 86400000) }).where(eq(Grant.id, id))
        await audit(tx, grant.campaign_id, "stripe", "payment_confirmed", id)
      })
    },
    async releaseUnpaid(id: string, sessionId: string) {
      const snapshot = await this.findGrant(id)
      if (!snapshot) return
      await db.transaction(async (tx) => {
        const campaign = await lockedCampaign(tx, snapshot.campaign_id)
        const grant = await lockedGrant(tx, id)
        if (grant.status !== "reserved" || grant.stripe_session_id !== sessionId) return
        await tx.update(Grant).set({ status: "released" }).where(eq(Grant.id, id))
        await tx.update(Campaign).set({ claimed: campaign.claimed - 1 }).where(eq(Campaign.id, campaign.id))
        await audit(tx, campaign.id, "stripe", "unpaid_checkout_released", id)
      })
    },
    async activate(id: string, identity: PromotionIdentity) {
      const snapshot = await this.findGrant(id)
      if (!snapshot) return fail("grant_not_found", "This promotional credit was not found.", 404)
      assertOwner(snapshot, identity)
      return db.transaction(async (tx) => {
        const campaign = await lockedCampaign(tx, snapshot.campaign_id)
        const grant = await lockedGrant(tx, id)
        assertOwner(grant, identity)
        await assertMember(tx, identity)
        await assertSubscription(tx, grant)
        if (campaign.status !== "active" && campaign.status !== "paused") fail("offer_stopped", "This offer is temporarily unavailable.")
        if (grant.status === "active") return publicGrant(grant)
        if (grant.status !== "available" || !grant.activate_by || grant.activate_by <= new Date()) fail("activation_expired", "This promotional credit is no longer available to activate.")
        const expires = new Date(Date.now() + grant.terms.durationSeconds * 1000)
        await tx.update(Grant).set({ status: "active", expires_at: expires }).where(eq(Grant.id, id))
        await audit(tx, campaign.id, identity.userId, "activated", id)
        return publicGrant({ ...grant, status: "active", expires_at: expires })
      })
    },
    async revoke(id: string, actor: string) {
      const snapshot = await this.findGrant(id)
      if (!snapshot) return
      await db.transaction(async (tx) => {
        await lockedCampaign(tx, snapshot.campaign_id)
        await tx.update(Grant).set({ status: "revoked" }).where(eq(Grant.id, id))
        await audit(tx, snapshot.campaign_id, actor, "revoked", id)
      })
    },
    async revokeSubscription(subscriptionId: string) {
      const rows = await db.select({ id: Grant.id }).from(Grant).where(eq(Grant.stripe_subscription_id, subscriptionId))
      for (const row of rows) await this.revoke(row.id, "stripe")
    },
    async executableModels(identity: PromotionIdentity) {
      const grants = await db.select({ grant: Grant, campaign: Campaign }).from(Grant).innerJoin(Campaign, eq(Campaign.id, Grant.campaign_id))
        .innerJoin(OrgSubscriptionTable, and(eq(OrgSubscriptionTable.organization_id, Grant.organization_id), eq(OrgSubscriptionTable.type, "inference"), eq(OrgSubscriptionTable.stripe_subscription_id, Grant.stripe_subscription_id)))
        .where(and(eq(Grant.user_id, identity.userId), eq(Grant.member_id, identity.memberId), eq(Grant.organization_id, identity.organizationId), eq(Grant.status, "active"),
          eq(OrgSubscriptionTable.status, "active"), eq(OrgSubscriptionTable.payment_failed, false), gte(OrgSubscriptionTable.current_period_end, new Date()),
          inArray(Campaign.status, ["active", "paused"]), gte(Grant.expires_at, new Date())))
      return grants.filter(({ grant }) => grant.paid_at && grant.credit_microusd > grant.spent_microusd + grant.reserved_microusd).map(({ grant }) => ({ id: grant.terms.alias, displayName: grant.terms.displayName, upstreamModel: grant.terms.upstreamModel }))
    },
    async isPromotionAlias(alias: string) { return (await db.select({ id: Campaign.id }).from(Campaign).where(eq(Campaign.alias, alias.replace(/^openwork\//, ""))).limit(1)).length > 0 },
    async reserveRequest(alias: string, identity: PromotionIdentity, requestId: string, prepare: (terms: ModelPromotionTerms) => { body: string; reserveMicrousd: number }) {
      const [snapshot] = await db.select({ id: Campaign.id }).from(Campaign).where(eq(Campaign.alias, alias.replace(/^openwork\//, "")))
      if (!snapshot) return fail("model_not_found", "This model offer was not found.", 404)
      return db.transaction(async (tx) => {
        const campaign = await lockedCampaign(tx, snapshot.id)
        if (!inArrayStatus(campaign.status)) fail("offer_stopped", "This promotional model is temporarily unavailable.", 503)
        const [grant] = await tx.select().from(Grant).where(and(eq(Grant.campaign_id, campaign.id), eq(Grant.user_id, identity.userId), eq(Grant.organization_id, identity.organizationId), eq(Grant.member_id, identity.memberId))).for("update")
        if (!grant) return fail("promotion_required", "Claim and activate this offer in OpenWork Models before using it.", 403)
        await assertMember(tx, identity)
        await assertSubscription(tx, grant)
        if (grant.status !== "active" || !grant.expires_at || grant.expires_at <= new Date()) fail("promotion_expired", "This promotional model is not active. Choose another model to continue; your work is saved.", 403)
        const prepared = prepare(grant.terms)
        const cost = prepared.reserveMicrousd
        if (!Number.isSafeInteger(cost) || cost <= 0) fail("request_unbounded", "This request cannot be safely priced.", 400)
        if (grant.spent_microusd + grant.reserved_microusd + cost > grant.credit_microusd) fail("promotion_credit_limit", "There is not enough promotional credit for this request. Choose another model or reduce the request size.", 429)
        if (campaign.spent_microusd + campaign.reserved_microusd + cost > campaign.terms.budgetMicrousd) fail("campaign_budget_limit", "This offer's inference budget is currently unavailable.", 429)
        const pending = await tx.select({ id: Request.id }).from(Request).where(and(eq(Request.grant_id, grant.id), eq(Request.status, "pending"))).limit(2)
        if (pending.length >= 2) fail("promotion_busy", "Two promotional requests are still being processed or reconciled. Try again shortly.", 429)
        const recent = await tx.select({ count: sql<number>`count(*)` }).from(Request).where(and(eq(Request.grant_id, grant.id), gte(Request.created_at, new Date(Date.now() - 60000))))
        if (Number(recent[0].count) >= grant.terms.requestsPerMinute) fail("promotion_rate_limit", "This offer's request limit was reached. Try again in a minute.", 429)
        await tx.insert(Request).values({ id: requestId, campaign_id: campaign.id, grant_id: grant.id, status: "pending", reserved_microusd: cost })
        await tx.update(Grant).set({ reserved_microusd: grant.reserved_microusd + cost }).where(eq(Grant.id, grant.id))
        await tx.update(Campaign).set({ reserved_microusd: campaign.reserved_microusd + cost }).where(eq(Campaign.id, campaign.id))
        return { ...prepared, apiKey: campaign.encrypted_key, grantId: grant.id, upstreamModel: grant.terms.upstreamModel }
      })
    },
    async noteGeneration(requestId: string, generationId: string) {
      await db.update(Request).set({ generation_id: generationId }).where(and(eq(Request.id, requestId), eq(Request.status, "pending")))
    },
    async settle(requestId: string, costMicrousd: number, generationId?: string) {
      const [snapshot] = await db.select().from(Request).where(eq(Request.id, requestId))
      if (!snapshot) return false
      if (!Number.isSafeInteger(costMicrousd) || costMicrousd < 0) fail("invalid_cost", "The provider cost could not be verified.")
      await db.transaction(async (tx) => {
        const campaign = await lockedCampaign(tx, snapshot.campaign_id)
        const grant = await lockedGrant(tx, snapshot.grant_id)
        const [request] = await tx.select().from(Request).where(eq(Request.id, requestId)).for("update")
        if (request.status !== "pending") return
        await tx.update(Request).set({ status: "settled", cost_microusd: costMicrousd, generation_id: generationId ?? request.generation_id }).where(eq(Request.id, requestId))
        await tx.update(Grant).set({ reserved_microusd: grant.reserved_microusd - request.reserved_microusd, spent_microusd: grant.spent_microusd + costMicrousd }).where(eq(Grant.id, grant.id))
        await tx.update(Campaign).set({ reserved_microusd: campaign.reserved_microusd - request.reserved_microusd, spent_microusd: campaign.spent_microusd + costMicrousd,
          ...(costMicrousd > request.reserved_microusd ? { status: "stopped" } : {}) }).where(eq(Campaign.id, campaign.id))
        if (costMicrousd > request.reserved_microusd) await audit(tx, campaign.id, "inference", "cost_ceiling_exceeded", requestId)
      })
      return true
    },
    async request(requestId: string) { return (await db.select().from(Request).where(eq(Request.id, requestId)))[0] ?? null },
    async campaignKey(id: string) { return (await db.select({ key: Campaign.encrypted_key }).from(Campaign).where(eq(Campaign.id, id)))[0]?.key ?? null },
  }
}
const inArrayStatus = (status: string) => status === "active" || status === "paused"
export type PromotionStore = ReturnType<typeof createPromotionStore>

export { preparePromotionRequest, promotionUsageCost, validatePromotionKey } from "./openrouter.js"
