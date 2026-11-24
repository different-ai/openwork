import { createHash } from "node:crypto"
import { z } from "zod"
import { and, countDistinct, desc, eq, gte, inArray, lt, ne, or } from "@openwork-ee/den-db/drizzle"
import { AnonymousInferenceUsageTable as GuestUsage, FreeAutoSafetyCaseTable as Cases, FreeAutoSafetyMemberTable as Mapping,
  InferenceFreeUsageTable as Usage, MemberTable } from "@openwork-ee/den-db/schema"
import { freeInferenceDigest } from "@openwork-ee/utils/free-inference-digest"
import { db } from "../db.js"
import { env } from "../env.js"

export const caseIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/)
export const caseStateSchema = z.enum(["review", "blocked", "closed"])
export const noticeSchema = z.enum(["warning", "deactivation", "local_review"])
export const providerCaseId = caseIdSchema.refine(id => !id.startsWith("local-"))
const providerNotice = z.enum(["warning", "deactivation"])
export const decisionSchema = z.enum(["confirmed_misuse", "no_violation", "appeal_upheld"])
const providerSchema = z.object({ object: z.literal("safety.case"), id: providerCaseId, notice: z.object({ type: providerNotice }),
  created_at: z.number().int().positive().max(2_147_483_647), entity_identifier: z.string().min(1), reason: z.string().nullish() })
type Notice = z.infer<typeof providerNotice>
type Row = typeof Cases.$inferSelect
const keyFor = (id: string) => createHash("sha256").update(id).digest("hex")
export function caseView(row: Row) {
  return { caseId: row.case_id, notice: row.notice, state: row.state, reason: row.reason, issuedAt: row.issued_at.toISOString(),
    identifier: row.identifier, decision: row.decision, reviewerId: row.reviewer_id, updatedAt: row.updated_at.toISOString() }
}

export async function importCase(id: string, expected?: Notice) {
  const key = env.openaiSafety.readKey
  if (!key) throw new Error("safety_case_read_key_missing")
  const response = await fetch(`https://api.openai.com/v1/safety/cases/${encodeURIComponent(id)}`, {
    headers: { authorization: `Bearer ${key}` }, redirect: "error", signal: AbortSignal.timeout(2500),
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error("safety_case_lookup_failed")
  }
  const notice = providerSchema.parse(await response.json())
  if (notice.id !== id || (expected === "deactivation" && notice.notice.type !== expected)) throw new Error("safety_case_mismatch")
  const identifier = /^[a-f0-9]{64}$/.test(notice.entity_identifier) ? notice.entity_identifier : null
  const type = notice.notice.type
  const caseKey = keyFor(id)
  return db.transaction(async tx => {
    await tx.insert(Cases).values({ case_key: caseKey, case_id: id, notice: type, identifier,
      reason: notice.reason?.slice(0, 100) ?? null, state: type === "deactivation" && identifier ? "blocked" : "review",
      issued_at: new Date(notice.created_at * 1000) }).onDuplicateKeyUpdate({ set: { case_key: caseKey } })
    const [row] = await tx.select().from(Cases).where(eq(Cases.case_key, caseKey)).for("update")
    if (!row || row.identifier !== identifier) throw new Error("safety_case_identity_changed")
    if (type === "deactivation" && row.notice === "warning") {
      const escalated = { notice: type, state: identifier ? "blocked" as const : "review" as const, decision: null, reviewer_id: null,
        reason: notice.reason?.slice(0, 100) ?? null, issued_at: new Date(notice.created_at * 1000) }
      await tx.update(Cases).set(escalated).where(eq(Cases.case_key, caseKey))
    }
  })
}

export async function openRequestCase(requestId: string, actor: NonNullable<Row["reviewer_id"]>) {
  const id = `local-${requestId}`
  const [member, guest] = await Promise.all([Usage, GuestUsage].map(table => db.$primary.select({
    hash: table.principal_hash, at: table.created_at,
  }).from(table).where(eq(table.request_id, requestId))))
  if (member.length + guest.length !== 1) return null
  const [request] = [...member, ...guest]
  const key = keyFor(id)
  await db.insert(Cases).values({ case_key: key, case_id: id, identifier: request.hash, issued_at: request.at,
    notice: "local_review", state: "review", reason: "reviewed_request", reviewer_id: actor })
    .onDuplicateKeyUpdate({ set: { case_key: key } })
  return id
}

export const caseCursor = z.string().regex(/^\d{1,13}\.[a-f0-9]{64}$/)
export async function listCases(state: Row["state"], limit: number, cursor?: string) {
  const [stamp, key] = cursor?.split(".") ?? []
  const time = new Date(Number(stamp))
  const before = cursor ? or(lt(Cases.issued_at, time), and(eq(Cases.issued_at, time), lt(Cases.case_key, key))) : undefined
  const rows = await db.$primary.select().from(Cases).where(and(eq(Cases.state, state), before))
    .orderBy(desc(Cases.issued_at), desc(Cases.case_key)).limit(limit + 1)
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  return { items: page.map(caseView), nextCursor: rows.length > limit && last ? [last.issued_at.getTime(), last.case_key].join(".") : null }
}

export async function reviewCase(id: string) {
  const [row] = await db.$primary.select().from(Cases).where(eq(Cases.case_key, keyFor(id)))
  if (!row) return null
  const result = { ...caseView(row), history: row.review_history ?? [] }
  const identifier = row.identifier
  if (!identifier) return { ...result, subject: "unknown" as const, userId: null, otherAccountsOnRecentDesktops: null, requests: [] }
  const primary = db.$primary
  const [mapping] = await primary.select().from(Mapping).where(eq(Mapping.identifier, identifier))
  const rows = await primary.select({ requestId: Usage.request_id, at: Usage.created_at, orgId: Usage.organization_id, desktopHash: Usage.desktop_hash, userId: MemberTable.userId })
    .from(Usage).leftJoin(MemberTable, and(eq(MemberTable.id, Usage.org_membership_id), eq(MemberTable.organizationId, Usage.organization_id)))
    .where(eq(Usage.principal_hash, identifier)).orderBy(desc(Usage.created_at)).limit(20)
  const matched = rows.find(r => r.userId && freeInferenceDigest("member", r.userId) === identifier)
  if (mapping || rows.length) {
    const since = new Date(Date.now() - 7 * 86_400_000)
    const desktops = [...new Set(rows.flatMap(r => r.desktopHash && r.at >= since ? [r.desktopHash] : []))]
    const [related] = desktops.length ? await primary.select({ count: countDistinct(Usage.principal_hash) }).from(Usage)
      .where(and(inArray(Usage.desktop_hash, desktops), ne(Usage.principal_hash, identifier), gte(Usage.created_at, since))) : []
    return { ...result, subject: "member" as const, userId: mapping?.user_id ?? matched?.userId ?? null,
      otherAccountsOnRecentDesktops: related?.count ?? null,
      requests: rows.map(r => ({ requestId: r.requestId, at: r.at.toISOString(), organizationId: r.orgId })) }
  }
  const guest = await primary.select({ requestId: GuestUsage.request_id, at: GuestUsage.created_at }).from(GuestUsage)
    .where(eq(GuestUsage.principal_hash, identifier)).orderBy(desc(GuestUsage.created_at)).limit(20)
  return { ...result, subject: guest.length ? "guest" as const : "unknown" as const, userId: null, otherAccountsOnRecentDesktops: null,
    requests: guest.map(r => ({ requestId: r.requestId, at: r.at.toISOString(), organizationId: null })) }
}

export async function decideCase(id: string, decision: z.infer<typeof decisionSchema>, actor: NonNullable<Row["reviewer_id"]>) {
  const key = keyFor(id)
  return db.transaction(async tx => {
    const [row] = await tx.select().from(Cases).where(eq(Cases.case_key, key)).for("update")
    if (!row) return "missing"
    if (row.notice === "deactivation") return "conflict"
    if (row.decision === decision) return "ok"
    if (decision === "appeal_upheld" ? row.state !== "blocked" : row.state !== "review") return "conflict"
    if (decision === "confirmed_misuse" && !row.identifier) return "conflict"
    const history = [...(row.review_history ?? []), { decision, reviewerId: actor, at: new Date().toISOString() }]
    await tx.update(Cases).set({ decision, reviewer_id: actor, review_history: history, state: decision === "confirmed_misuse" ? "blocked" : "closed" })
      .where(eq(Cases.case_key, key))
    return "ok"
  })
}
