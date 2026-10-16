import { createHmac, hkdfSync, randomUUID, timingSafeEqual } from "node:crypto"
import { and, eq, inArray, isNotNull, isNull, sql } from "@openwork-ee/den-db/drizzle"
import { AuthSessionTable, AuthUserTable, GatewayLocalKeyShareTable, MemberTable, OrganizationTable, TeamTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { GATEWAY_LOCAL_KEY_SHARE_PROVIDERS, type GatewayLocalKeyShareEligibility, type GatewayLocalKeyShareInput, type GatewayLocalKeyShareProvider, type GatewayLocalKeyShareReceipt } from "@openwork/types/den/gateway"
import { db } from "../db.js"
import { gatewayManagementUnavailable } from "../gateway-deployment.js"
import { ORGANIZATION_ADMIN_ROLE, organizationRoleValueSatisfies } from "../organization-role-hierarchy.js"
import { hasFreshPrivilegedSession } from "../routes/org/shared.js"
import { gatewayCatalog, type GatewayTx } from "./gateway-matrix.js"
import { createGatewayProvider, type GatewayCreationCatalog } from "./gateway-provider-create.js"

export type LocalKeySharePrincipal = {
  organizationId: typeof OrganizationTable.$inferSelect.id;
  memberId: typeof MemberTable.$inferSelect.id;
  userId: typeof AuthSessionTable.$inferSelect.userId;
  sessionId: typeof AuthSessionTable.$inferSelect.id;
  sessionToken: string;
}
const standardSdk: Record<GatewayLocalKeyShareProvider, string> = {
  anthropic: "@ai-sdk/anthropic", openai: "@ai-sdk/openai", google: "@ai-sdk/google", openrouter: "@openrouter/ai-sdk-provider",
}
export const LOCAL_KEY_SHARE_UNSUPPORTED = "Only standard Anthropic, OpenAI, Google and OpenRouter API keys can be shared. Custom providers and OAuth credentials stay private."
export class LocalKeyShareError extends Error {
  constructor(readonly status: 400 | 403 | 409, readonly code: string, message: string) { super(message) }
}
function supportedProvider(providerId: string) {
  return GATEWAY_LOCAL_KEY_SHARE_PROVIDERS.find((id) => id === providerId)
}

async function currentIdentity(database: typeof db | GatewayTx, principal: LocalKeySharePrincipal, lock: boolean) {
  const orgQuery = database.select({ id: OrganizationTable.id, name: OrganizationTable.name }).from(OrganizationTable)
    .where(eq(OrganizationTable.id, principal.organizationId)).limit(1)
  const [organization] = await (lock ? orgQuery.for("update") : orgQuery)
  const memberQuery = database.select().from(MemberTable).where(and(eq(MemberTable.id, principal.memberId),
    eq(MemberTable.organizationId, principal.organizationId), eq(MemberTable.userId, principal.userId), isNull(MemberTable.removedAt), isNotNull(MemberTable.joinedAt))).limit(1)
  const [member] = await (lock ? memberQuery.for("update") : memberQuery)
  const sessionQuery = database.select({ session: AuthSessionTable, nowMs: sql<number>`unix_timestamp(current_timestamp(3)) * 1000` }).from(AuthSessionTable)
    .innerJoin(AuthUserTable, eq(AuthUserTable.id, AuthSessionTable.userId))
    .where(and(eq(AuthSessionTable.id, principal.sessionId), eq(AuthSessionTable.userId, principal.userId), eq(AuthSessionTable.token, principal.sessionToken))).limit(1)
  const [row] = await (lock ? sessionQuery.for("update") : sessionQuery)
  const now = new Date(Number(row?.nowMs))
  if (!organization?.name.trim() || organization.id !== principal.organizationId || !member?.joinedAt || member.removedAt !== null
    || member.id !== principal.memberId || member.organizationId !== principal.organizationId || member.userId !== principal.userId
    || !row || row.session.id !== principal.sessionId || row.session.userId !== principal.userId || row.session.token !== principal.sessionToken
    || !Number.isFinite(now.getTime()) || row.session.expiresAt.getTime() <= now.getTime()) {
    throw new LocalKeyShareError(403, "share_identity_unverified", "Sign in again and select an active organization membership before sharing.")
  }
  const reason = !organizationRoleValueSatisfies({ roleValue: member.role, requiredRole: ORGANIZATION_ADMIN_ROLE })
    ? "Only current organization owners and admins can share device keys."
    : !hasFreshPrivilegedSession({ session: row.session }, now)
      ? "Confirm your identity in Den with a fresh owner or admin session before sharing."
      : gatewayManagementUnavailable()?.message ?? null
  return { organization, member, reason }
}

export async function requireLocalKeyShareAdministrator(principal: LocalKeySharePrincipal): Promise<void> {
  const identity = await currentIdentity(db, principal, false)
  if (identity.reason) throw new LocalKeyShareError(403, "share_not_allowed", identity.reason)
}

export async function localKeyShareEligibility(principal: LocalKeySharePrincipal, providerId: string): Promise<GatewayLocalKeyShareEligibility> {
  const identity = await currentIdentity(db, principal, false)
  const reason = identity.reason ?? (supportedProvider(providerId) ? null : LOCAL_KEY_SHARE_UNSUPPORTED)
  const teams = reason ? [] : await db.select({ id: TeamTable.id, name: TeamTable.name }).from(TeamTable)
    .where(eq(TeamTable.organizationId, principal.organizationId)).orderBy(TeamTable.name, TeamTable.id)
  return { organizationId: identity.organization.id, memberId: identity.member.id, organizationName: identity.organization.name,
    teams, eligible: reason === null, reason }
}

/**
 * Keyed with material derived from the out-of-database encryption secret so a
 * database-only reader cannot use the stored tag as a confirmation oracle for
 * the shared API key. Den never stores the raw secret in this tag.
 */
function localKeyShareHashKey() {
  const secret = process.env.DEN_DB_ENCRYPTION_KEY?.trim()
  if (!secret || secret.length < 32) throw new LocalKeyShareError(409, "share_provider_unavailable", "Sharing is unavailable until Den credential encryption is configured. Your local key is unchanged.")
  return new Uint8Array(hkdfSync("sha256", secret, "", "openwork-gateway-local-key-share-v1", 32))
}
export function localKeyShareRequestHash(principal: Pick<LocalKeySharePrincipal, "organizationId" | "memberId" | "userId">, input: GatewayLocalKeyShareInput) {
  return createHmac("sha256", localKeyShareHashKey()).update(JSON.stringify([1, principal.organizationId, principal.memberId, principal.userId,
    input.requestId, input.providerId, input.name, input.credential.kind, input.credential.secret, input.allMembers, [...new Set(input.teamIds)].sort()])).digest("hex")
}
function matchesHash(stored: string, next: string) {
  return /^[a-f0-9]{64}$/.test(stored) && timingSafeEqual(Uint8Array.from(Buffer.from(stored, "hex")), Uint8Array.from(Buffer.from(next, "hex")))
}
function receipt(row: typeof GatewayLocalKeyShareTable.$inferSelect): GatewayLocalKeyShareReceipt {
  return { requestId: row.request_id, organizationId: row.organization_id, providerId: row.provider_id, inferenceProviderId: row.gateway_provider_id }
}
async function attemptShare(tx: GatewayTx, principal: LocalKeySharePrincipal, input: GatewayLocalKeyShareInput, hash: string, catalog?: GatewayCreationCatalog): Promise<GatewayLocalKeyShareReceipt | null> {
  const identity = await currentIdentity(tx, principal, true)
  if (identity.reason) throw new LocalKeyShareError(403, "share_not_allowed", identity.reason)
  const [existing] = await tx.select().from(GatewayLocalKeyShareTable).where(and(
    eq(GatewayLocalKeyShareTable.organization_id, principal.organizationId), eq(GatewayLocalKeyShareTable.org_membership_id, principal.memberId),
    eq(GatewayLocalKeyShareTable.request_id, input.requestId))).limit(1).for("update")
  if (existing && (!matchesHash(existing.request_hash, hash) || existing.provider_id !== input.providerId)) {
    throw new LocalKeyShareError(409, "share_request_conflict", "This transfer ID was already used for different contents. Verify the earlier share in Den.")
  }
  // A committed transfer is acknowledged as-is; later team changes are managed in Den, not re-validated on retry.
  if (existing) return receipt(existing)
  const teamIds = [...new Set(input.teamIds)].sort().map((id) => normalizeDenTypeId("team", id))
  if (teamIds.length) {
    const teams = await tx.select({ id: TeamTable.id }).from(TeamTable).where(and(eq(TeamTable.organizationId, principal.organizationId), inArray(TeamTable.id, teamIds)))
      .orderBy(TeamTable.id).for("update")
    if (teams.length !== teamIds.length) throw new LocalKeyShareError(400, "share_audience_changed", "Choose teams that still belong to this organization. No new transfer was created.")
  }
  if (!catalog) return null
  const provider = await createGatewayProvider(tx, principal.organizationId, principal.memberId, {
    name: input.name, providerId: input.providerId, modelIds: [], credentialMode: "org", credential: input.credential,
    allMembers: input.allMembers, teamIds,
  }, catalog)
  const saved: typeof GatewayLocalKeyShareTable.$inferInsert = {
    id: randomUUID(), organization_id: principal.organizationId, org_membership_id: principal.memberId,
    request_id: input.requestId, request_hash: hash, provider_id: input.providerId, gateway_provider_id: provider.id,
  }
  await tx.insert(GatewayLocalKeyShareTable).values(saved)
  return { requestId: input.requestId, organizationId: principal.organizationId, providerId: input.providerId, inferenceProviderId: provider.id }
}

export async function shareLocalProviderKey(principal: LocalKeySharePrincipal, input: GatewayLocalKeyShareInput): Promise<GatewayLocalKeyShareReceipt> {
  const vendor = supportedProvider(input.providerId)
  if (!vendor) throw new LocalKeyShareError(400, "share_provider_unsupported", LOCAL_KEY_SHARE_UNSUPPORTED)
  if (input.credential.kind !== "api_key" || !input.credential.secret.trim() || (input.allMembers ? input.teamIds.length !== 0 : input.teamIds.length === 0)) {
    throw new LocalKeyShareError(400, "invalid_share", "Provide a supported API key and choose everyone or selected teams.")
  }
  const hash = localKeyShareRequestHash(principal, input)
  const previous = await db.transaction((tx) => attemptShare(tx, principal, input, hash))
  if (previous) return previous
  const catalog = await gatewayCatalog(vendor, [])
  if (catalog.catalog.id !== vendor || catalog.catalog.npm !== standardSdk[vendor]) {
    throw new LocalKeyShareError(409, "share_provider_unavailable", "The standard provider catalog could not be verified. Your local key is unchanged.")
  }
  const result = await db.transaction((tx) => attemptShare(tx, principal, input, hash, catalog))
  if (!result) throw new Error("share_not_committed")
  return result
}
