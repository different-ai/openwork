import { createHash, randomUUID } from "node:crypto"
import {
  type EnterpriseMcpOAuthAuthorizationHandle,
  type EnterpriseMcpOAuthClientRegistration,
  type EnterpriseMcpOAuthCredential,
  type EnterpriseMcpOAuthPersistence,
  type EnterpriseMcpPersistenceContext,
} from "@openwork/enterprise-mcp-client"
import { and, eq } from "@openwork-ee/den-db/drizzle"
import {
  ConnectedAccountTable,
  ExternalMcpConnectionTable,
  OrgOAuthClientTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import {
  OAuthClientInformationFullSchema,
  OAuthClientInformationSchema,
  type OAuthClientInformationMixed,
  type OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js"
import { z } from "zod"
import { db } from "../db.js"
import type { ExternalMcpMemberContext } from "./external-mcp-client.js"
import { externalMcpOAuthRuntimeFromStateToken } from "./generic-oauth.js"
import {
  assertExternalMcpOAuthAuthorizationActorForCommit,
  clearLegacyExternalMcpPendingCodeVerifierIfMatches,
  consumeExternalMcpOAuthTransaction,
  deleteExternalMcpOAuthTransaction,
  externalMcpIdentityBinding,
  ExternalMcpOAuthAuthorizationRevokedError,
  persistExternalMcpDcrOAuthClientWithLease,
  releaseExternalMcpOAuthRegistrationLease,
  saveExternalMcpOAuthTransaction,
  tryAcquireExternalMcpOAuthRegistrationLease,
  type ExternalMcpAuthorizationActor,
  type ExternalMcpConnectionRow,
} from "./external-mcp-connections.js"

const MAX_PENDING_AUTHORIZATIONS = 8
const ENTERPRISE_MCP_DCR_LEASE_STALE_MS = 30_000
const ENTERPRISE_MCP_DCR_LEASE_POLL_MS = 100
const ENTERPRISE_MCP_CLIENT_INFORMATION_KEY = "clientInformationV2"
const LEGACY_ENTERPRISE_MCP_CLIENT_INFORMATION_KEY = "clientInformation"

const pendingAuthorizationSchema = z.object({
  idHash: z.string().length(64),
  revision: z.string().uuid(),
  codeVerifier: z.string().min(43).max(256),
  expiresAt: z.number().int().positive(),
  clientRegistrationRevision: z.string().min(1).optional(),
  authorizationEpoch: z.number().int().nonnegative().default(0),
})

const pendingAuthorizationEnvelopeSchema = z.object({
  version: z.literal(1),
  transactions: z.array(pendingAuthorizationSchema).max(MAX_PENDING_AUTHORIZATIONS),
})

type PendingAuthorization = z.infer<typeof pendingAuthorizationSchema>

function stateHash(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function parsePendingAuthorizations(value: string | null | undefined): PendingAuthorization[] {
  if (!value) return []
  try {
    const parsed: unknown = JSON.parse(value)
    const envelope = pendingAuthorizationEnvelopeSchema.safeParse(parsed)
    return envelope.success ? envelope.data.transactions : []
  } catch {
    // A verifier written by the current Den client is deliberately not
    // reinterpreted as an enterprise transaction because it has no state,
    // expiry, client revision, or single-use binding.
    return []
  }
}

function serializePendingAuthorizations(transactions: PendingAuthorization[]): string | null {
  if (transactions.length === 0) return null
  return JSON.stringify({ version: 1, transactions })
}

function assertCommitActive(context: EnterpriseMcpPersistenceContext, now = Date.now()): void {
  if (context.signal.aborted || now >= context.commitExpiresAt) {
    throw new Error("The enterprise MCP persistence deadline expired before the transaction could commit.")
  }
}

function clientRevision(input: {
  id: string
  updatedAt: Date
  clientId: string
  clientSecret: string | null
  extra: Record<string, unknown> | null
}): string {
  const extra = { ...(input.extra ?? {}) }
  const versioned = extra[ENTERPRISE_MCP_CLIENT_INFORMATION_KEY]
  const legacy = extra[LEGACY_ENTERPRISE_MCP_CLIENT_INFORMATION_KEY]
  const metadata = typeof versioned === "object" && versioned !== null && !Array.isArray(versioned)
    ? versioned
    : typeof legacy === "object" && legacy !== null && !Array.isArray(legacy)
      ? legacy
      : undefined
  delete extra[ENTERPRISE_MCP_CLIENT_INFORMATION_KEY]
  delete extra[LEGACY_ENTERPRISE_MCP_CLIENT_INFORMATION_KEY]
  if (metadata) extra[ENTERPRISE_MCP_CLIENT_INFORMATION_KEY] = safeClientInformation(metadata)
  return createHash("sha256")
    .update(input.id)
    .update("\0")
    .update(input.updatedAt.toISOString())
    .update("\0")
    .update(input.clientId)
    .update("\0")
    // Never turn the revision into an offline verifier for a weak client
    // secret. Secret rotations still move updatedAt; only presence is needed
    // to distinguish public and confidential registrations semantically.
    .update(input.clientSecret === null ? "public" : "confidential")
    .update("\0")
    .update(JSON.stringify(extra))
    .digest("hex")
}

function credentialRevision(input: {
  kind: "shared" | "per_member"
  id: string
  updatedAt: Date
  accessToken: string | null
  refreshToken: string | null
  tokenType: string | null
  scope: string | string[] | null
  expiresAt: Date | null
  connectedAt: Date | null
}): string {
  return createHash("sha256")
    .update(JSON.stringify([
      input.kind,
      input.id,
      input.accessToken,
      input.refreshToken,
      input.tokenType,
      input.scope,
      input.expiresAt?.toISOString() ?? null,
      input.connectedAt?.toISOString() ?? null,
      input.updatedAt.toISOString(),
    ]))
    .digest("hex")
}

function sharedCredentialRevision(
  connection: Pick<
    ExternalMcpConnectionRow,
    "id" | "updatedAt" | "accessToken" | "refreshToken" | "tokenType" | "scope" | "expiresAt" | "connectedAt"
  >,
): string {
  return credentialRevision({ ...connection, kind: "shared" })
}

function memberCredentialRevision(input: {
  id: string
  updatedAt: Date
  accessToken: string | null
  refreshToken: string | null
  tokenType: string | null
  scopes: string[] | null
  expiresAt: Date | null
  connectedAt: Date
}): string {
  return credentialRevision({ ...input, kind: "per_member", scope: input.scopes })
}

function sharedCredential(
  connection: ExternalMcpConnectionRow,
): EnterpriseMcpOAuthCredential | undefined {
  if (!connection.accessToken) return undefined
  return {
    tokens: {
      access_token: connection.accessToken,
      token_type: connection.tokenType ?? "Bearer",
      refresh_token: connection.refreshToken ?? undefined,
      scope: connection.scope ?? undefined,
    },
    expiresAt: connection.expiresAt?.getTime(),
    revision: sharedCredentialRevision(connection),
  }
}

function memberCredential(
  account: Parameters<typeof memberCredentialRevision>[0],
): EnterpriseMcpOAuthCredential | undefined {
  if (!account.accessToken) return undefined
  return {
    tokens: {
      access_token: account.accessToken,
      token_type: account.tokenType ?? "Bearer",
      refresh_token: account.refreshToken ?? undefined,
      scope: account.scopes?.join(" ") ?? undefined,
    },
    expiresAt: account.expiresAt?.getTime(),
    revision: memberCredentialRevision(account),
  }
}

function clientExpiration(clientInformation: OAuthClientInformationMixed): number | undefined {
  const parsed = OAuthClientInformationFullSchema.safeParse(clientInformation)
  const seconds = parsed.success ? parsed.data.client_secret_expires_at : undefined
  return seconds && seconds > 0 ? seconds * 1_000 : undefined
}

function clientRegistrationSource(
  extra: Record<string, unknown> | null,
): EnterpriseMcpOAuthClientRegistration["source"] {
  if (extra?.enterpriseMcpRegistrationSource === "dynamic" || extra?.registrationProvenance === "dcr") {
    return "dynamic"
  }
  if (extra?.enterpriseMcpRegistrationSource === "client-metadata" || extra?.registrationProvenance === "cimd") {
    return "client-metadata"
  }
  // Unmarked legacy metadata is ambiguous after secret-only administrator
  // rotations. Preserve it as pre-registered; only explicit DCR provenance
  // authorizes automatic deletion.
  return "pre-registered"
}

function safeClientInformation(clientInformation: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(clientInformation).filter(([key]) => (
    key !== "client_secret" && key !== "registration_access_token"
  )))
}

function scrubbedClientExtra(extra: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!Object.prototype.hasOwnProperty.call(extra ?? {}, LEGACY_ENTERPRISE_MCP_CLIENT_INFORMATION_KEY)) {
    return extra
  }
  const next = { ...(extra ?? {}) }
  const versioned = next[ENTERPRISE_MCP_CLIENT_INFORMATION_KEY]
  const legacy = next[LEGACY_ENTERPRISE_MCP_CLIENT_INFORMATION_KEY]
  const candidate = typeof versioned === "object" && versioned !== null && !Array.isArray(versioned)
    ? versioned
    : typeof legacy === "object" && legacy !== null && !Array.isArray(legacy)
      ? legacy
      : undefined
  delete next[LEGACY_ENTERPRISE_MCP_CLIENT_INFORMATION_KEY]
  if (candidate) {
    next[ENTERPRISE_MCP_CLIENT_INFORMATION_KEY] = safeClientInformation(candidate)
  }
  return Object.keys(next).length > 0 ? next : null
}

function restoredClientInformation(input: {
  clientId: string
  clientSecret: string | null
  extra: Record<string, unknown> | null
}): OAuthClientInformationMixed {
  const versioned = input.extra?.[ENTERPRISE_MCP_CLIENT_INFORMATION_KEY]
  const legacy = input.extra?.[LEGACY_ENTERPRISE_MCP_CLIENT_INFORMATION_KEY]
  const candidate = typeof versioned === "object" && versioned !== null && !Array.isArray(versioned)
    ? versioned
    : typeof legacy === "object" && legacy !== null && !Array.isArray(legacy)
      ? legacy
      : undefined
  const full = OAuthClientInformationFullSchema.safeParse({
    ...(typeof candidate === "object" && candidate !== null ? candidate : {}),
    client_id: input.clientId,
    client_secret: input.clientSecret ?? undefined,
  })
  if (full.success) return full.data
  return OAuthClientInformationSchema.parse({
    client_id: input.clientId,
    client_secret: input.clientSecret ?? undefined,
  })
}

export class DenEnterpriseMcpOAuthPersistence implements EnterpriseMcpOAuthPersistence {
  private connection: ExternalMcpConnectionRow
  private readonly identityBinding: string
  private readonly authorizationEpoch: number
  private readonly claimedAuthorizations = new Map<string, EnterpriseMcpOAuthAuthorizationHandle>()
  private readonly member?: ExternalMcpMemberContext
  private readonly authorizationActor?: ExternalMcpAuthorizationActor

  constructor(
    connection: ExternalMcpConnectionRow,
    member?: ExternalMcpMemberContext,
    authorizationActor?: ExternalMcpAuthorizationActor,
  ) {
    this.connection = connection
    this.identityBinding = externalMcpIdentityBinding(connection)
    this.authorizationEpoch = connection.oauthAuthorizationEpoch
    this.member = member
    this.authorizationActor = authorizationActor
    if (connection.credentialMode === "per_member" && !member) {
      throw new Error(`Connection "${connection.id}" uses per-member credentials; a member context is required.`)
    }
  }

  private get isPerMember(): boolean {
    return this.connection.credentialMode === "per_member"
  }

  private assertCurrentIdentity(connection: ExternalMcpConnectionRow): void {
    if (externalMcpIdentityBinding(connection) !== this.identityBinding) {
      throw new Error("The enterprise MCP connection identity changed before credentials could be persisted.")
    }
  }

  private async refreshConnection(): Promise<void> {
    const rows = await db
      .select()
      .from(ExternalMcpConnectionTable)
      .where(and(
        eq(ExternalMcpConnectionTable.id, this.connection.id),
        eq(ExternalMcpConnectionTable.organizationId, this.connection.organizationId),
      ))
      .limit(1)
    if (!rows[0]) throw new Error("The enterprise MCP connection no longer exists.")
    this.assertCurrentIdentity(rows[0])
    this.connection = rows[0]
  }

  private async memberAccount() {
    if (!this.member) return null
    const rows = await db
      .select()
      .from(ConnectedAccountTable)
      .where(and(
        eq(ConnectedAccountTable.organizationId, this.connection.organizationId),
        eq(ConnectedAccountTable.orgMembershipId, this.member.orgMembershipId),
        eq(ConnectedAccountTable.providerId, this.connection.id),
      ))
      .limit(1)
    return rows[0] ?? null
  }

  private registrationAuthorizationActor(): ExternalMcpAuthorizationActor {
    const authorizationActor = this.authorizationActor
    if (!authorizationActor) {
      throw new Error("An authorization actor is required before persisting an enterprise MCP OAuth client registration.")
    }
    if (
      this.isPerMember
      && authorizationActor.orgMembershipId !== this.member?.orgMembershipId
    ) throw new ExternalMcpOAuthAuthorizationRevokedError()
    return authorizationActor
  }

  readonly clientRegistrations = {
    load: async (context: EnterpriseMcpPersistenceContext): Promise<EnterpriseMcpOAuthClientRegistration | undefined> => {
      assertCommitActive(context)
      await this.refreshConnection()
      const row = await db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(OrgOAuthClientTable)
          .where(and(
            eq(OrgOAuthClientTable.organizationId, this.connection.organizationId),
            eq(OrgOAuthClientTable.providerId, this.connection.id),
          ))
          .limit(1)
          .for("update")
        const current = rows[0]
        if (!current) return undefined
        const extra = scrubbedClientExtra(current.extra)
        if (extra === current.extra) return current

        // Older current-runtime rows could contain client_secret or a
        // registration access token in plaintext JSON. Rewrite under the row
        // lock before returning it, keeping the secret only in the encrypted
        // clientSecret column and returning the post-rewrite revision.
        await tx
          .update(OrgOAuthClientTable)
          .set({ extra, updatedAt: current.updatedAt })
          .where(eq(OrgOAuthClientTable.id, current.id))
        const scrubbedRows = await tx
          .select()
          .from(OrgOAuthClientTable)
          .where(eq(OrgOAuthClientTable.id, current.id))
          .limit(1)
        assertCommitActive(context)
        return scrubbedRows[0]
      })
      if (!row) return undefined
      const clientInformation = restoredClientInformation(row)
      return {
        clientInformation,
        revision: clientRevision(row),
        expiresAt: clientExpiration(clientInformation),
        source: clientRegistrationSource(row.extra),
      }
    },

    claimDynamicRegistration: async (
      context: EnterpriseMcpPersistenceContext,
    ): Promise<
      | { status: "acquired"; claim: string }
      | { status: "existing"; registration: EnterpriseMcpOAuthClientRegistration }
    > => {
      this.registrationAuthorizationActor()
      const claim = randomUUID()
      while (true) {
        assertCommitActive(context)
        const now = new Date()
        const result = await tryAcquireExternalMcpOAuthRegistrationLease({
          organizationId: this.connection.organizationId,
          connectionId: this.connection.id,
          expectedIdentityBinding: this.identityBinding,
          expectedAuthorizationEpoch: this.authorizationEpoch,
          authorizationActor: this.registrationAuthorizationActor(),
          assertActive: () => assertCommitActive(context),
          leaseToken: claim,
          startedAt: now,
          staleBefore: new Date(now.getTime() - ENTERPRISE_MCP_DCR_LEASE_STALE_MS),
        })
        if (result === "connection_missing") {
          throw new Error("The enterprise MCP connection no longer exists.")
        }
        if (result === "connection_changed") {
          throw new Error("The enterprise MCP connection was disconnected while OAuth registration was starting.")
        }
        if (result === "acquired") {
          const registration = await this.clientRegistrations.load(context)
          if (!registration) return { status: "acquired", claim }
          await releaseExternalMcpOAuthRegistrationLease({
            organizationId: this.connection.organizationId,
            connectionId: this.connection.id,
            expectedIdentityBinding: this.identityBinding,
            leaseToken: claim,
          })
          return { status: "existing", registration }
        }

        const registration = await this.clientRegistrations.load(context)
        if (registration) return { status: "existing", registration }
        await new Promise<void>((resolve, reject) => {
          const remaining = Math.max(0, context.commitExpiresAt - Date.now())
          let timer: ReturnType<typeof setTimeout>
          const aborted = () => {
            clearTimeout(timer)
            reject(new Error("The enterprise MCP lifecycle ended while waiting for OAuth client registration."))
          }
          timer = setTimeout(() => {
            context.signal.removeEventListener("abort", aborted)
            resolve()
          }, Math.min(ENTERPRISE_MCP_DCR_LEASE_POLL_MS, remaining))
          context.signal.addEventListener("abort", aborted, { once: true })
        })
      }
    },

    releaseDynamicRegistration: async (claim: string): Promise<void> => {
      await releaseExternalMcpOAuthRegistrationLease({
        organizationId: this.connection.organizationId,
        connectionId: this.connection.id,
        expectedIdentityBinding: this.identityBinding,
        leaseToken: claim,
      })
    },

    save: async (input: {
      context: EnterpriseMcpPersistenceContext
      clientInformation: OAuthClientInformationMixed
      expiresAt?: number
      source: "dynamic" | "client-metadata"
      claim?: string
    }): Promise<EnterpriseMcpOAuthClientRegistration> => {
      const authorizationActor = this.registrationAuthorizationActor()
      if (input.source === "dynamic") {
        if (!input.claim) {
          throw new Error("Dynamic OAuth client registration requires an active distributed claim.")
        }
        const persistedRevision = await persistExternalMcpDcrOAuthClientWithLease({
          organizationId: this.connection.organizationId,
          connectionId: this.connection.id,
          expectedIdentityBinding: this.identityBinding,
          expectedAuthorizationEpoch: this.authorizationEpoch,
          leaseToken: input.claim,
          authorizationActor,
          clientId: input.clientInformation.client_id,
          clientSecret: input.clientInformation.client_secret ?? null,
          extra: {
            [ENTERPRISE_MCP_CLIENT_INFORMATION_KEY]: safeClientInformation(input.clientInformation),
            enterpriseMcpRegistrationSource: "dynamic",
            registrationProvenance: "dcr",
          },
          assertActive: () => assertCommitActive(input.context),
        })
        const rows = await db
          .select()
          .from(OrgOAuthClientTable)
          .where(and(
            eq(OrgOAuthClientTable.organizationId, this.connection.organizationId),
            eq(OrgOAuthClientTable.providerId, this.connection.id),
          ))
          .limit(1)
        const row = rows[0]
        if (!row || clientRevision(row) !== clientRevision(persistedRevision)) {
          throw new Error("The dynamically registered OAuth client changed before it could be returned.")
        }
        const clientInformation = restoredClientInformation(row)
        return {
          clientInformation,
          revision: clientRevision(row),
          expiresAt: clientExpiration(clientInformation),
          source: clientRegistrationSource(row.extra),
        }
      }
      const row = await db.transaction(async (tx) => {
        const connections = await tx
          .select()
          .from(ExternalMcpConnectionTable)
          .where(and(
            eq(ExternalMcpConnectionTable.id, this.connection.id),
            eq(ExternalMcpConnectionTable.organizationId, this.connection.organizationId),
          ))
          .limit(1)
          .for("update")
        const connection = connections[0]
        if (!connection) throw new Error("The enterprise MCP connection no longer exists.")
        this.assertCurrentIdentity(connection)
        assertCommitActive(input.context)
        if (connection.oauthAuthorizationEpoch !== this.authorizationEpoch) {
          throw new Error("The enterprise MCP connection was disconnected while OAuth client registration was in progress.")
        }
        await assertExternalMcpOAuthAuthorizationActorForCommit({
          tx,
          connection,
          authorizationActor,
        })
        const existing = await tx
          .select()
          .from(OrgOAuthClientTable)
          .where(and(
            eq(OrgOAuthClientTable.organizationId, this.connection.organizationId),
            eq(OrgOAuthClientTable.providerId, this.connection.id),
          ))
          .limit(1)
          .for("update")
        if (existing[0]) return existing[0]
        const id = createDenTypeId("orgOAuthClient")
        await tx.insert(OrgOAuthClientTable).values({
          id,
          organizationId: this.connection.organizationId,
          providerId: this.connection.id,
          clientId: input.clientInformation.client_id,
          clientSecret: input.clientInformation.client_secret ?? null,
          extra: {
            [ENTERPRISE_MCP_CLIENT_INFORMATION_KEY]: safeClientInformation(input.clientInformation),
            enterpriseMcpRegistrationSource: input.source,
            registrationProvenance: input.source === "dynamic" ? "dcr" : "cimd",
          },
          createdByOrgMembershipId: authorizationActor.orgMembershipId,
        })
        const inserted = await tx
          .select()
          .from(OrgOAuthClientTable)
          .where(eq(OrgOAuthClientTable.id, id))
          .limit(1)
        assertCommitActive(input.context)
        if (!inserted[0]) throw new Error("The enterprise MCP OAuth client registration was not persisted.")
        return inserted[0]
      })
      const clientInformation = restoredClientInformation(row)
      return {
        clientInformation,
        revision: clientRevision(row),
        expiresAt: clientExpiration(clientInformation),
        source: clientRegistrationSource(row.extra),
      }
    },

    invalidate: async (input: {
      context: EnterpriseMcpPersistenceContext
      reason: "expired" | "provider-rejected"
      revision: string
    }): Promise<void> => {
      await db.transaction(async (tx) => {
        const connections = await tx
          .select()
          .from(ExternalMcpConnectionTable)
          .where(and(
            eq(ExternalMcpConnectionTable.id, this.connection.id),
            eq(ExternalMcpConnectionTable.organizationId, this.connection.organizationId),
          ))
          .limit(1)
          .for("update")
        if (!connections[0]) return
        this.assertCurrentIdentity(connections[0])
        assertCommitActive(input.context)
        if (connections[0].oauthAuthorizationEpoch !== this.authorizationEpoch) return
        const clients = await tx
          .select()
          .from(OrgOAuthClientTable)
          .where(and(
            eq(OrgOAuthClientTable.organizationId, this.connection.organizationId),
            eq(OrgOAuthClientTable.providerId, this.connection.id),
          ))
          .limit(1)
          .for("update")
        const client = clients[0]
        if (
          !client
          || clientRevision(client) !== input.revision
          || clientRegistrationSource(client.extra) !== "dynamic"
        ) return
        await tx.delete(OrgOAuthClientTable).where(eq(OrgOAuthClientTable.id, client.id))
        assertCommitActive(input.context)
      })
    },
  }

  readonly authorizations = {
    begin: async (input: {
      context: EnterpriseMcpPersistenceContext
      id: string
      codeVerifier: string
      expiresAt: number
      clientRegistrationRevision?: string
    }): Promise<void> => {
      const authorizationActor = this.registrationAuthorizationActor()
      await saveExternalMcpOAuthTransaction({
        organizationId: this.connection.organizationId,
        connectionId: this.connection.id,
        orgMembershipId: this.member?.orgMembershipId ?? authorizationActor.orgMembershipId,
        authorizationActor,
        expectedAuthorizationEpoch: this.authorizationEpoch,
        expectedIdentityBinding: this.identityBinding,
        signedState: input.id,
        codeVerifier: input.codeVerifier,
        clientRegistrationRevision: input.clientRegistrationRevision,
        expiresAt: new Date(input.expiresAt),
        assertActive: () => assertCommitActive(input.context),
      })
      assertCommitActive(input.context)
      await this.refreshConnection()
    },

    load: async (input: {
      context: EnterpriseMcpPersistenceContext
      id: string
    }): Promise<{ handle: EnterpriseMcpOAuthAuthorizationHandle; codeVerifier: string } | undefined> => {
      assertCommitActive(input.context)
      const orgMembershipId = this.member?.orgMembershipId ?? this.authorizationActor?.orgMembershipId
      if (!orgMembershipId) {
        throw new Error("An authorization actor is required before completing enterprise MCP OAuth.")
      }
      const transaction = await consumeExternalMcpOAuthTransaction({
        organizationId: this.connection.organizationId,
        connectionId: this.connection.id,
        orgMembershipId,
        expectedIdentityBinding: this.identityBinding,
        signedState: input.id,
      })
      if (!transaction) {
        // Expand-release fallback only. Marked states from this release are
        // always state-keyed, so a missing row is a replay and must not steal
        // an older single-slot verifier.
        if (externalMcpOAuthRuntimeFromStateToken(input.id)) return undefined
        const legacy = await this.consumeLegacyAuthorization(input.context, input.id)
        if (!legacy) return undefined
        const handle: EnterpriseMcpOAuthAuthorizationHandle = {
          id: input.id,
          revision: randomUUID(),
          expiresAt: legacy.expiresAt,
          clientRegistrationRevision: legacy.clientRegistrationRevision,
          authorizationEpoch: legacy.authorizationEpoch,
        }
        this.claimedAuthorizations.set(handle.revision, handle)
        return {
          handle,
          codeVerifier: legacy.codeVerifier,
        }
      }
      await this.clearMatchingLegacyCodeVerifier(transaction.codeVerifier, orgMembershipId)
      const handle: EnterpriseMcpOAuthAuthorizationHandle = {
        id: input.id,
        revision: randomUUID(),
        expiresAt: transaction.expiresAt.getTime(),
        clientRegistrationRevision: transaction.clientRegistrationRevision,
        authorizationEpoch: transaction.authorizationEpoch,
      }
      this.claimedAuthorizations.set(handle.revision, handle)
      return {
        handle,
        codeVerifier: transaction.codeVerifier,
      }
    },

    invalidate: async (input: {
      context: EnterpriseMcpPersistenceContext
      id: string
      reason: "expired" | "abandoned" | "provider-rejected"
    }): Promise<void> => {
      assertCommitActive(input.context)
      const orgMembershipId = this.member?.orgMembershipId ?? this.authorizationActor?.orgMembershipId
      if (!orgMembershipId) return
      const codeVerifier = await deleteExternalMcpOAuthTransaction({
        organizationId: this.connection.organizationId,
        connectionId: this.connection.id,
        orgMembershipId,
        expectedIdentityBinding: this.identityBinding,
        signedState: input.id,
      })
      if (codeVerifier) {
        await this.clearMatchingLegacyCodeVerifier(codeVerifier, orgMembershipId)
      } else if (!externalMcpOAuthRuntimeFromStateToken(input.id)) {
        await this.consumeLegacyAuthorization(input.context, input.id)
      }
    },
  }

  readonly credentials = {
    load: async (context: EnterpriseMcpPersistenceContext) => {
      assertCommitActive(context)
      await this.refreshConnection()
      if (this.isPerMember) {
        const account = await this.memberAccount()
        return account ? memberCredential(account) : undefined
      }
      return sharedCredential(this.connection)
    },

    save: async (input: {
      context: EnterpriseMcpPersistenceContext
      tokens: OAuthTokens
      expiresAt?: number
      source: "authorization-code" | "refresh"
      authorization?: EnterpriseMcpOAuthAuthorizationHandle
      clientRegistrationRevision?: string
    }): Promise<EnterpriseMcpOAuthCredential> => {
      const saved = await db.transaction(async (tx) => {
        const connections = await tx
          .select()
          .from(ExternalMcpConnectionTable)
          .where(and(
            eq(ExternalMcpConnectionTable.id, this.connection.id),
            eq(ExternalMcpConnectionTable.organizationId, this.connection.organizationId),
          ))
          .limit(1)
          .for("update")
        const connection = connections[0]
        if (!connection) throw new Error("The enterprise MCP connection no longer exists.")
        this.assertCurrentIdentity(connection)
        assertCommitActive(input.context)
        if (
          input.source === "refresh"
          && connection.oauthAuthorizationEpoch !== this.authorizationEpoch
        ) throw new Error("The MCP connection was disconnected before refreshed credentials could be saved.")
        if (input.source === "authorization-code") {
          const authorizationActor = this.authorizationActor
          if (!authorizationActor) {
            throw new Error("An authorization actor is required to commit enterprise MCP OAuth credentials.")
          }
          if (
            this.isPerMember
            && authorizationActor.orgMembershipId !== this.member?.orgMembershipId
          ) throw new ExternalMcpOAuthAuthorizationRevokedError()
          await assertExternalMcpOAuthAuthorizationActorForCommit({
            tx,
            connection,
            authorizationActor,
          })
        }
        const account = this.member
          ? (await tx
              .select()
              .from(ConnectedAccountTable)
              .where(and(
                eq(ConnectedAccountTable.organizationId, this.connection.organizationId),
                eq(ConnectedAccountTable.orgMembershipId, this.member.orgMembershipId),
                eq(ConnectedAccountTable.providerId, this.connection.id),
              ))
              .limit(1)
              .for("update"))[0]
          : undefined
        if (input.source === "authorization-code") {
          const authorization = input.authorization
          if (!authorization) throw new Error("An authorization-code token commit requires its transaction handle.")
          const claimed = this.claimedAuthorizations.get(authorization.revision)
          if (
            !claimed
            || claimed.id !== authorization.id
            || claimed.expiresAt !== authorization.expiresAt
            || claimed.authorizationEpoch !== authorization.authorizationEpoch
            || authorization.expiresAt <= Date.now()
          ) throw new Error("The OAuth authorization is missing, expired, or already consumed.")
          // The handle is adapter-local and one-shot. The state row was
          // already atomically consumed before the token endpoint request;
          // deleting this claim before the credential write prevents a
          // caller from replaying the returned opaque handle.
          this.claimedAuthorizations.delete(authorization.revision)
          if (authorization.authorizationEpoch !== connection.oauthAuthorizationEpoch) {
            throw new Error("The MCP connection was disconnected before OAuth credentials could be saved.")
          }
          if (authorization.clientRegistrationRevision !== input.clientRegistrationRevision) {
            throw new Error("The OAuth client registration changed after authorization started.")
          }
          const clients = await tx
            .select()
            .from(OrgOAuthClientTable)
            .where(and(
              eq(OrgOAuthClientTable.organizationId, this.connection.organizationId),
              eq(OrgOAuthClientTable.providerId, this.connection.id),
            ))
            .limit(1)
            .for("update")
          if (!clients[0] || clientRevision(clients[0]) !== input.clientRegistrationRevision) {
            throw new Error("The OAuth client registration changed after authorization started.")
          }
        }
        const expiresAt = input.expiresAt === undefined ? null : new Date(input.expiresAt)
        if (this.isPerMember && this.member) {
          if (account) {
            await tx
              .update(ConnectedAccountTable)
              .set({
                accessToken: input.tokens.access_token,
                refreshToken: input.tokens.refresh_token ?? account.refreshToken ?? null,
                tokenType: input.tokens.token_type ?? null,
                scopes: input.tokens.scope !== undefined
                  ? input.tokens.scope.split(" ").filter(Boolean)
                  : account.scopes,
                expiresAt,
              })
              .where(eq(ConnectedAccountTable.id, account.id))
            const persistedRows = await tx
              .select()
              .from(ConnectedAccountTable)
              .where(eq(ConnectedAccountTable.id, account.id))
              .limit(1)
            const persisted = persistedRows[0]
            const credential = persisted ? memberCredential(persisted) : undefined
            if (!credential) throw new Error("The enterprise MCP account disappeared before credentials could commit.")
            assertCommitActive(input.context)
            return credential
          } else {
            throw new Error(input.source === "refresh"
              ? "The per-member MCP account was disconnected before refreshed credentials could be saved."
              : "The MCP OAuth account was disconnected before credentials could be saved.")
          }
        } else {
          await tx
            .update(ExternalMcpConnectionTable)
            .set({
              accessToken: input.tokens.access_token,
              refreshToken: input.tokens.refresh_token ?? connection.refreshToken ?? null,
              tokenType: input.tokens.token_type ?? null,
              scope: input.tokens.scope !== undefined ? input.tokens.scope : connection.scope,
              expiresAt,
              connectedAt: new Date(),
            })
            .where(eq(ExternalMcpConnectionTable.id, connection.id))
          const persistedRows = await tx
            .select()
            .from(ExternalMcpConnectionTable)
            .where(eq(ExternalMcpConnectionTable.id, connection.id))
            .limit(1)
          const persisted = persistedRows[0]
          const credential = persisted ? sharedCredential(persisted) : undefined
          if (!credential) throw new Error("The enterprise MCP connection disappeared before credentials could commit.")
          assertCommitActive(input.context)
          return credential
        }
      })
      await this.refreshConnection()
      return saved
    },

    invalidate: async (input: {
      context: EnterpriseMcpPersistenceContext
      reason: "expired" | "provider-rejected" | "post-authorization-validation-failed"
      revision: string
    }): Promise<void> => {
      await db.transaction(async (tx) => {
        const connections = await tx
          .select()
          .from(ExternalMcpConnectionTable)
          .where(and(
            eq(ExternalMcpConnectionTable.id, this.connection.id),
            eq(ExternalMcpConnectionTable.organizationId, this.connection.organizationId),
          ))
          .limit(1)
          .for("update")
        const connection = connections[0]
        if (!connection) return
        this.assertCurrentIdentity(connection)
        assertCommitActive(input.context)
        if (this.isPerMember && this.member) {
          const accounts = await tx
            .select()
            .from(ConnectedAccountTable)
            .where(and(
              eq(ConnectedAccountTable.organizationId, this.connection.organizationId),
              eq(ConnectedAccountTable.orgMembershipId, this.member.orgMembershipId),
              eq(ConnectedAccountTable.providerId, this.connection.id),
            ))
            .limit(1)
            .for("update")
          const account = accounts[0]
          if (!account || memberCredentialRevision(account) !== input.revision) return
          await tx
            .update(ConnectedAccountTable)
            .set({ accessToken: null, refreshToken: null, tokenType: null, scopes: null, expiresAt: null })
            .where(eq(ConnectedAccountTable.id, account.id))
        } else {
          if (sharedCredentialRevision(connection) !== input.revision) return
          await tx
            .update(ExternalMcpConnectionTable)
            .set({
              accessToken: null,
              refreshToken: null,
              tokenType: null,
              scope: null,
              expiresAt: null,
              connectedAt: null,
            })
            .where(eq(ExternalMcpConnectionTable.id, connection.id))
        }
        assertCommitActive(input.context)
      })
      await this.refreshConnection()
    },
  }

  private async clearMatchingLegacyCodeVerifier(
    codeVerifier: string,
    orgMembershipId: ExternalMcpMemberContext["orgMembershipId"],
  ): Promise<void> {
    try {
      await clearLegacyExternalMcpPendingCodeVerifierIfMatches({
        organizationId: this.connection.organizationId,
        connectionId: this.connection.id,
        orgMembershipId,
        expectedIdentityBinding: this.identityBinding,
        expectedCodeVerifier: codeVerifier,
      })
    } catch {
      // The exact state row was already consumed. Legacy cleanup is an
      // expand-release bridge and must not discard the valid verifier before
      // the token endpoint receives it.
    }
  }

  private async consumeLegacyAuthorization(
    context: EnterpriseMcpPersistenceContext,
    id: string,
  ): Promise<PendingAuthorization | undefined> {
    const consumed = await db.transaction(async (tx) => {
      const connections = await tx
        .select()
        .from(ExternalMcpConnectionTable)
        .where(and(
          eq(ExternalMcpConnectionTable.id, this.connection.id),
          eq(ExternalMcpConnectionTable.organizationId, this.connection.organizationId),
        ))
        .limit(1)
        .for("update")
      const connection = connections[0]
      if (!connection) return
      this.assertCurrentIdentity(connection)
      assertCommitActive(context)
      const account = this.member
        ? (await tx
            .select()
            .from(ConnectedAccountTable)
            .where(and(
              eq(ConnectedAccountTable.organizationId, this.connection.organizationId),
              eq(ConnectedAccountTable.orgMembershipId, this.member.orgMembershipId),
              eq(ConnectedAccountTable.providerId, this.connection.id),
            ))
            .limit(1)
            .for("update"))[0]
        : undefined
      const existing = this.isPerMember ? account?.pendingCodeVerifier : connection.pendingCodeVerifier
      const transactions = parsePendingAuthorizations(existing)
      const transaction = transactions.find((candidate) => candidate.idHash === stateHash(id))
      if (!transaction) return undefined
      const pendingCodeVerifier = serializePendingAuthorizations(
        transactions.filter((candidate) => candidate.revision !== transaction.revision),
      )
      if (this.isPerMember && account) {
        await tx
          .update(ConnectedAccountTable)
          .set({ pendingCodeVerifier })
          .where(eq(ConnectedAccountTable.id, account.id))
      } else if (!this.isPerMember) {
        await tx
          .update(ExternalMcpConnectionTable)
          .set({ pendingCodeVerifier })
          .where(eq(ExternalMcpConnectionTable.id, connection.id))
      }
      assertCommitActive(context)
      return transaction
    })
    await this.refreshConnection()
    return consumed
  }
}
