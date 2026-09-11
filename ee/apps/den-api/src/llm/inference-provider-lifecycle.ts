import { and, eq, inArray, isNull } from "@openwork-ee/den-db/drizzle"
import { GatewayKeyTable, GatewayCredentialSetTable, GatewayModelGroupTable, GatewayProviderAccessTable, GatewayProviderCredentialTable, GatewayProviderOauthStateTable, GatewayProviderTable, InferenceKeyTable, MemberTable, TeamMemberTable, TeamTable } from "@openwork-ee/den-db/schema"
import { parseGatewayProviderSecret } from "@openwork/types/den/gateway"
import { db } from "../db.js"
import { isGoogleOAuthInferenceProviderId, revokeGoogleToken } from "./inference-provider-google-oauth.js"

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
type MemberId = typeof MemberTable.$inferSelect.id
type Provider = typeof GatewayProviderTable.$inferSelect
type Credential = typeof GatewayProviderCredentialTable.$inferSelect
type CredentialSet = typeof GatewayCredentialSetTable.$inferSelect

/** Caller holds all member fences. States precede credentials for the entire batch. */
export async function revokeInferenceCredentialsForMembers(tx: Tx, memberIds: MemberId[]) {
  if (!memberIds.length) return []
  await tx.delete(GatewayProviderOauthStateTable).where(inArray(GatewayProviderOauthStateTable.org_membership_id, memberIds))
  const credentials = await tx.select().from(GatewayProviderCredentialTable)
    .where(inArray(GatewayProviderCredentialTable.org_membership_id, memberIds)).for("update")
  await tx.update(InferenceKeyTable).set({ status: "revoked", revoked_at: new Date() })
    .where(and(inArray(InferenceKeyTable.org_membership_id, memberIds), eq(InferenceKeyTable.status, "active")))
  await tx.update(GatewayKeyTable).set({ status: "revoked", revoked_at: new Date(), updated_at: new Date() })
    .where(and(inArray(GatewayKeyTable.org_membership_id, memberIds), eq(GatewayKeyTable.status, "active")))
  await tx.update(GatewayProviderCredentialTable).set({ status: "revoked", refreshing_until: null, updated_at: new Date() })
    .where(inArray(GatewayProviderCredentialTable.org_membership_id, memberIds))
  return credentials.filter((credential) => credential.status !== "revoked")
}

export async function revokeGoogleCredentials(credentials: Credential[]) {
  const signal = AbortSignal.timeout(5_000)
  let index = 0
  await Promise.all(Array.from({ length: Math.min(4, credentials.length) }, async () => {
    while (index < credentials.length && !signal.aborted) {
      const credential = credentials[index++]
      try {
        const parsed = parseGatewayProviderSecret(credential.kind, credential.secret)
        if (parsed.kind === "oauth_google") await revokeGoogleToken({ token: parsed.token.refreshToken ?? parsed.token.accessToken, signal })
      } catch {
        // Local revocation remains authoritative if decoding or Google fails.
      }
    }
  }))
}

export async function revokeMemberGatewayCredentials(input: { organizationId: Provider["organization_id"]; memberId: MemberId }) {
  const credentials = await db.transaction(async (tx) => {
    const [member] = await tx.select({ organizationId: MemberTable.organizationId }).from(MemberTable)
      .where(eq(MemberTable.id, input.memberId)).for("update")
    if (member && member.organizationId !== input.organizationId) return []
    // The trusted deletion hook also calls after the membership row is physically gone.
    return revokeInferenceCredentialsForMembers(tx, [input.memberId])
  })
  await revokeGoogleCredentials(credentials)
}

export async function memberGatewayTeams(database: Tx | typeof db, organizationId: Provider["organization_id"], memberId: MemberId) {
  return database.select({ id: TeamMemberTable.teamId }).from(TeamMemberTable)
    .innerJoin(TeamTable, eq(TeamTable.id, TeamMemberTable.teamId))
    .where(and(eq(TeamMemberTable.orgMembershipId, memberId), eq(TeamTable.organizationId, organizationId)))
}

/** Enumerate explicit group/set choices, not raw-model automatic resolution. Distinct granted sets stay selectable. */
export function effectiveGatewayGrants(grants: Array<typeof GatewayProviderAccessTable.$inferSelect>, memberId: MemberId, teamIds: string[]) {
  const priority = (grant: typeof GatewayProviderAccessTable.$inferSelect) => grant.org_membership_id
    ? grant.org_membership_id === memberId && grant.team_id === null ? 3 : 0
    : grant.team_id ? teamIds.includes(grant.team_id) ? 2 : 0 : 1
  const eligible = grants.filter((grant) => priority(grant) > 0)
  return eligible.filter((grant) => !eligible.some((other) => other.model_group_id === grant.model_group_id
      && other.credential_set_id === grant.credential_set_id && priority(other) > priority(grant)))
    .sort((a, b) => a.id.localeCompare(b.id))
    .filter((grant, index, rows) => rows.findIndex((other) => other.model_group_id === grant.model_group_id && other.credential_set_id === grant.credential_set_id) === index)
}

/** Lock order: member, provider, set, group/access, state, credential. Never hold locks during HTTP. */
export async function lockMemberOAuthAuthorization(tx: Tx, provider: Provider, set: CredentialSet, memberId: MemberId) {
  const [member] = await tx.select().from(MemberTable)
    .where(and(eq(MemberTable.id, memberId), eq(MemberTable.organizationId, provider.organization_id), isNull(MemberTable.removedAt))).for("update")
  if (!member?.userId) return false
  const [current] = await tx.select().from(GatewayProviderTable).where(eq(GatewayProviderTable.id, provider.id)).for("update")
  if (!current || current.status !== "active" || !isGoogleOAuthInferenceProviderId(current.provider_id)
    || current.organization_id !== provider.organization_id || current.provider_id !== provider.provider_id) return false
  const [currentSet] = await tx.select().from(GatewayCredentialSetTable).where(eq(GatewayCredentialSetTable.id, set.id)).for("update")
  if (!currentSet || currentSet.gateway_provider_id !== provider.id || currentSet.status !== "active" || currentSet.credential_mode !== "member"
    || currentSet.oauth_client_id !== set.oauth_client_id || currentSet.oauth_client_secret !== set.oauth_client_secret) return false
  const teams = await memberGatewayTeams(tx, provider.organization_id, memberId)
  const rows = await tx.select({ grant: GatewayProviderAccessTable }).from(GatewayProviderAccessTable)
    .innerJoin(GatewayModelGroupTable, and(eq(GatewayModelGroupTable.id, GatewayProviderAccessTable.model_group_id), eq(GatewayModelGroupTable.gateway_provider_id, provider.id), eq(GatewayModelGroupTable.status, "active")))
    .innerJoin(GatewayCredentialSetTable, and(eq(GatewayCredentialSetTable.id, GatewayProviderAccessTable.credential_set_id), eq(GatewayCredentialSetTable.gateway_provider_id, provider.id), eq(GatewayCredentialSetTable.status, "active")))
    .where(eq(GatewayProviderAccessTable.gateway_provider_id, provider.id)).for("update")
  return effectiveGatewayGrants(rows.map((row) => row.grant), memberId, teams.map((team) => team.id)).some((grant) => grant.credential_set_id === set.id)
}

/** Fence team changes against callbacks; callbacks reauthorize the selected set without canceling unrelated consent. */
export async function invalidateTeamInferenceOAuth(tx: Tx, teamId: typeof TeamTable.$inferSelect.id) {
  const grants = await tx.select({ id: GatewayProviderAccessTable.gateway_provider_id }).from(GatewayProviderAccessTable)
    .where(eq(GatewayProviderAccessTable.team_id, teamId))
  if (!grants.length) return
  const providerIds = [...new Set(grants.map((grant) => grant.id))]
  await tx.select({ id: GatewayProviderTable.id }).from(GatewayProviderTable)
    .where(inArray(GatewayProviderTable.id, providerIds)).orderBy(GatewayProviderTable.id).for("update")
}
