import { and, eq, inArray, isNull, or } from "@openwork-ee/den-db/drizzle"
import { InferenceKeyTable, InferenceProviderAccessTable, InferenceProviderCredentialTable, InferenceProviderOauthStateTable, InferenceProviderTable, MemberTable, TeamMemberTable, TeamTable } from "@openwork-ee/den-db/schema"
import { parseInferenceProviderSecret } from "@openwork/types/den/inference"
import { db } from "../db.js"
import { isGoogleOAuthInferenceProviderId, revokeGoogleToken } from "./inference-provider-google-oauth.js"

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
type MemberId = typeof MemberTable.$inferSelect.id
type Provider = typeof InferenceProviderTable.$inferSelect
type Credential = typeof InferenceProviderCredentialTable.$inferSelect

/** Caller holds all member fences. Every state in the batch precedes every credential lock. */
export async function revokeInferenceCredentialsForMembers(tx: Tx, memberIds: MemberId[]) {
  if (!memberIds.length) return []
  await tx.delete(InferenceProviderOauthStateTable).where(inArray(InferenceProviderOauthStateTable.org_membership_id, memberIds))
  const credentials = await tx.select().from(InferenceProviderCredentialTable)
    .where(inArray(InferenceProviderCredentialTable.org_membership_id, memberIds)).for("update")
  await tx.update(InferenceKeyTable).set({ status: "revoked", revoked_at: new Date() })
    .where(and(inArray(InferenceKeyTable.org_membership_id, memberIds), eq(InferenceKeyTable.status, "active")))
  await tx.update(InferenceProviderCredentialTable).set({ status: "revoked", refreshing_until: null, updated_at: new Date() })
    .where(inArray(InferenceProviderCredentialTable.org_membership_id, memberIds))
  return credentials.filter((credential) => credential.status !== "revoked")
}

export async function revokeGoogleCredentials(credentials: Credential[]) {
  // Bound both concurrency and total offboarding latency, not five seconds per grant.
  const signal = AbortSignal.timeout(5_000)
  let index = 0
  await Promise.all(Array.from({ length: Math.min(4, credentials.length) }, async () => {
    while (index < credentials.length && !signal.aborted) {
      const credential = credentials[index++]
      try {
        const parsed = parseInferenceProviderSecret(credential.kind, credential.secret)
        if (parsed.kind === "oauth_google") {
          await revokeGoogleToken({ token: parsed.token.refreshToken ?? parsed.token.accessToken, signal })
        }
      } catch {
        // Local revocation remains authoritative if decoding or Google fails.
      }
    }
  }))
}

export async function revokeMemberGatewayCredentials(input: { organizationId: Provider["organization_id"]; memberId: MemberId }) {
  const credentials = await db.transaction(async (tx) => {
    await tx.select({ id: MemberTable.id }).from(MemberTable)
      .where(and(eq(MemberTable.id, input.memberId), eq(MemberTable.organizationId, input.organizationId))).for("update")
    return revokeInferenceCredentialsForMembers(tx, [input.memberId])
  })
  await revokeGoogleCredentials(credentials)
}

/** Lock order: member, provider, then access. Re-read after waiting, never trust a start-time grant. */
export async function lockMemberOAuthAuthorization(tx: Tx, provider: Provider, memberId: MemberId) {
  const [member] = await tx.select().from(MemberTable)
    .where(and(eq(MemberTable.id, memberId), eq(MemberTable.organizationId, provider.organization_id), isNull(MemberTable.removedAt))).for("update")
  if (!member?.userId) return false
  const [current] = await tx.select().from(InferenceProviderTable).where(eq(InferenceProviderTable.id, provider.id)).for("update")
  if (!current || current.status !== "active" || current.credential_mode !== "member"
    || !isGoogleOAuthInferenceProviderId(current.provider_id)
    || current.organization_id !== provider.organization_id || current.provider_id !== provider.provider_id
    || current.oauth_client_id !== provider.oauth_client_id || current.oauth_client_secret !== provider.oauth_client_secret) return false
  const teams = await tx.select({ id: TeamMemberTable.teamId }).from(TeamMemberTable)
    .innerJoin(TeamTable, eq(TeamTable.id, TeamMemberTable.teamId))
    .where(and(eq(TeamMemberTable.orgMembershipId, memberId), eq(TeamTable.organizationId, provider.organization_id))).for("update")
  const access = await tx.select({ id: InferenceProviderAccessTable.id }).from(InferenceProviderAccessTable)
    .where(and(eq(InferenceProviderAccessTable.inference_provider_id, provider.id), or(
      eq(InferenceProviderAccessTable.org_membership_id, memberId),
      ...(teams.length ? [inArray(InferenceProviderAccessTable.team_id, teams.map((team) => team.id))] : []),
      and(isNull(InferenceProviderAccessTable.org_membership_id), isNull(InferenceProviderAccessTable.team_id)),
    ))).for("update")
  return access.length > 0
}

/** Team changes share the provider fence with callbacks, including already-claimed states. */
export async function invalidateTeamInferenceOAuth(tx: Tx, teamId: typeof TeamTable.$inferSelect.id) {
  const grants = await tx.select({ id: InferenceProviderAccessTable.inference_provider_id }).from(InferenceProviderAccessTable)
    .where(eq(InferenceProviderAccessTable.team_id, teamId))
  if (!grants.length) return
  const providerIds = [...new Set(grants.map((grant) => grant.id))]
  // Never lock an access row before its provider (the callback takes the opposite order).
  await tx.select({ id: InferenceProviderTable.id }).from(InferenceProviderTable)
    .where(inArray(InferenceProviderTable.id, providerIds)).orderBy(InferenceProviderTable.id).for("update")
  await tx.delete(InferenceProviderOauthStateTable)
    .where(inArray(InferenceProviderOauthStateTable.inference_provider_id, providerIds))
}
