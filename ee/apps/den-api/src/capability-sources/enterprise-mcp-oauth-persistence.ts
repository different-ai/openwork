import { createHash, randomUUID } from "node:crypto"
import {
  EnterpriseMcpOAuthContractError,
  type EnterpriseMcpOAuthAuthorizationHandle,
  type EnterpriseMcpOAuthClientRegistration,
  type EnterpriseMcpOAuthPersistence,
  type EnterpriseMcpPersistenceContext,
} from "@openwork/enterprise-mcp-client"
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js"
import { and, eq } from "@openwork-ee/den-db/drizzle"
import {
  ConnectedAccountTable,
  ExternalMcpConnectionTable,
  OrgOAuthClientTable,
  type ExternalMcpCredentialHealth,
  type ExternalMcpOAuthConfiguration,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import {
  OAuthClientInformationFullSchema,
  OAuthClientInformationSchema,
  OAuthMetadataSchema,
  OAuthProtectedResourceMetadataSchema,
  OpenIdProviderMetadataSchema,
  type OAuthClientInformationMixed,
  type OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js"
import { z } from "zod"
import { db } from "../db.js"
import type { ExternalMcpMemberContext } from "./external-mcp-client.js"
import {
  externalMcpIdentityBinding,
  type ExternalMcpConnectionRow,
} from "./external-mcp-connections.js"
import { externalMcpCallbackUrl } from "./external-mcp-oauth-contract.js"
import { normalizeConnectedAccountScopes, normalizeOAuthClientExtra } from "./oauth-credentials.js"

const MAX_PENDING_AUTHORIZATIONS = 8

function credentialHealth(
  status: ExternalMcpCredentialHealth["status"],
  reason: ExternalMcpCredentialHealth["reason"],
): ExternalMcpCredentialHealth {
  return { version: 1, status, reason, checkedAt: new Date().toISOString() }
}

function invalidCredentialHealth(
  reason: "expired" | "provider-rejected" | "post-authorization-validation-failed",
): ExternalMcpCredentialHealth {
  if (reason === "expired") return credentialHealth("reconnect_required", "credential_expired")
  if (reason === "post-authorization-validation-failed") {
    return credentialHealth("reconnect_required", "post_authorization_validation_failed")
  }
  return credentialHealth("reconnect_required", "authorization_rejected")
}

const oauthDiscoveryStateSchema = z.object({
  authorizationServerUrl: z.string().url(),
  authorizationServerMetadata: OAuthMetadataSchema.or(OpenIdProviderMetadataSchema).optional(),
  resourceMetadata: OAuthProtectedResourceMetadataSchema.optional(),
  resourceMetadataUrl: z.string().url().optional(),
})

const pendingAuthorizationSchema = z.object({
  idHash: z.string().length(64),
  revision: z.string().uuid(),
  codeVerifier: z.string().min(43).max(256),
  expiresAt: z.number().int().positive(),
  clientRegistrationRevision: z.string().min(1).optional(),
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
}): string {
  return createHash("sha256")
    .update(input.id)
    .update("\0")
    .update(input.updatedAt.toISOString())
    .update("\0")
    .update(input.clientId)
    .update("\0")
    .update(input.clientSecret ?? "")
    .digest("hex")
}

function clientExpiration(clientInformation: OAuthClientInformationMixed): number | undefined {
  const parsed = OAuthClientInformationFullSchema.safeParse(clientInformation)
  const seconds = parsed.success ? parsed.data.client_secret_expires_at : undefined
  return seconds && seconds > 0 ? seconds * 1_000 : undefined
}

function safeClientInformation(clientInformation: OAuthClientInformationMixed): Record<string, unknown> {
  return Object.fromEntries(Object.entries(clientInformation).filter(([key]) => (
    key !== "client_secret" && key !== "registration_access_token"
  )))
}

function restoredClientInformation(input: {
  clientId: string
  clientSecret: string | null
  extra: Record<string, unknown> | null
}): OAuthClientInformationMixed {
  const candidate = input.extra?.clientInformation
  const tokenEndpointAuthMethod = input.extra?.tokenEndpointAuthMethod
  const registeredRedirectUri = input.extra?.registeredRedirectUri
  const full = OAuthClientInformationFullSchema.safeParse({
    ...(typeof candidate === "object" && candidate !== null ? candidate : {}),
    client_id: input.clientId,
    client_secret: input.clientSecret ?? undefined,
    ...(tokenEndpointAuthMethod === "client_secret_basic" || tokenEndpointAuthMethod === "client_secret_post"
      ? {
          token_endpoint_auth_method: tokenEndpointAuthMethod,
          ...(typeof registeredRedirectUri === "string" ? { redirect_uris: [registeredRedirectUri] } : {}),
        }
      : {}),
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
  private readonly member?: ExternalMcpMemberContext

  constructor(connection: ExternalMcpConnectionRow, member?: ExternalMcpMemberContext) {
    this.connection = connection
    this.identityBinding = externalMcpIdentityBinding(connection)
    this.member = member
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
    return rows[0]
      ? { ...rows[0], scopes: normalizeConnectedAccountScopes(rows[0].scopes) }
      : null
  }

  readonly clientRegistrations = {
    load: async (context: EnterpriseMcpPersistenceContext): Promise<EnterpriseMcpOAuthClientRegistration | undefined> => {
      assertCommitActive(context)
      await this.refreshConnection()
      const rows = await db
        .select()
        .from(OrgOAuthClientTable)
        .where(and(
          eq(OrgOAuthClientTable.organizationId, this.connection.organizationId),
          eq(OrgOAuthClientTable.providerId, this.connection.id),
        ))
        .limit(1)
      const row = rows[0]
      if (!row) return undefined
      const extra = normalizeOAuthClientExtra(row.extra)
      const registeredRedirectUri = typeof extra?.registeredRedirectUri === "string"
        ? extra.registeredRedirectUri
        : undefined
      const currentRedirectUri = externalMcpCallbackUrl({
        connectionId: this.connection.id,
        callbackMode: this.connection.oauthConfiguration?.callbackMode ?? "legacy-v1",
      })
      if (
        extra?.enterpriseMcpRegistrationSource === "pre-registered"
        && registeredRedirectUri !== currentRedirectUri
      ) {
        throw new EnterpriseMcpOAuthContractError(
          "MCP_OAUTH_CONFIGURATION_REQUIRED",
          `The pre-registered OAuth client must allowlist the callback URL ${currentRedirectUri}.`,
        )
      }
      const clientInformation = restoredClientInformation({ ...row, extra })
      return {
        clientInformation,
        revision: clientRevision(row),
        expiresAt: clientExpiration(clientInformation),
        source: extra?.enterpriseMcpRegistrationSource === "dynamic"
          ? "dynamic"
          : extra?.enterpriseMcpRegistrationSource === "client-metadata"
            ? "client-metadata"
            : "pre-registered",
      }
    },

    save: async (input: {
      context: EnterpriseMcpPersistenceContext
      clientInformation: OAuthClientInformationMixed
      expiresAt?: number
      source: "client-metadata" | "dynamic"
    }): Promise<EnterpriseMcpOAuthClientRegistration> => {
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
        if (!connections[0]) throw new Error("The enterprise MCP connection no longer exists.")
        this.assertCurrentIdentity(connections[0])
        assertCommitActive(input.context)
        const existing = await tx
          .select()
          .from(OrgOAuthClientTable)
          .where(and(
            eq(OrgOAuthClientTable.organizationId, this.connection.organizationId),
            eq(OrgOAuthClientTable.providerId, this.connection.id),
          ))
          .limit(1)
        if (existing[0]) return existing[0]
        const id = createDenTypeId("orgOAuthClient")
        await tx.insert(OrgOAuthClientTable).values({
          id,
          organizationId: this.connection.organizationId,
          providerId: this.connection.id,
          clientId: input.clientInformation.client_id,
          clientSecret: input.clientInformation.client_secret ?? null,
          extra: {
            clientInformation: safeClientInformation(input.clientInformation),
            enterpriseMcpRegistrationSource: input.source,
            registrationContractVersion: 2,
            registeredRedirectUri: externalMcpCallbackUrl({
              connectionId: this.connection.id,
              callbackMode: this.connection.oauthConfiguration?.callbackMode ?? "legacy-v1",
            }),
            authorizationServerIssuer: this.connection.oauthConfiguration?.authorizationServerIssuer ?? undefined,
          },
          createdByOrgMembershipId: this.connection.createdByOrgMembershipId,
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
        source: row.extra?.enterpriseMcpRegistrationSource === "dynamic"
          ? "dynamic"
          : row.extra?.enterpriseMcpRegistrationSource === "client-metadata"
            ? "client-metadata"
            : "pre-registered",
      }
    },

    invalidate: async (input: {
      context: EnterpriseMcpPersistenceContext
      reason: "expired" | "provider-rejected"
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
        await tx
          .delete(OrgOAuthClientTable)
          .where(and(
            eq(OrgOAuthClientTable.organizationId, this.connection.organizationId),
            eq(OrgOAuthClientTable.providerId, this.connection.id),
          ))
      })
    },
  }

  readonly discovery = {
    load: async (context: EnterpriseMcpPersistenceContext): Promise<OAuthDiscoveryState | undefined> => {
      assertCommitActive(context)
      await this.refreshConnection()
      const parsed = oauthDiscoveryStateSchema.safeParse(this.connection.oauthConfiguration?.discovery)
      return parsed.success ? parsed.data : undefined
    },

    save: async (input: {
      context: EnterpriseMcpPersistenceContext
      state: OAuthDiscoveryState
    }): Promise<void> => {
      const state = oauthDiscoveryStateSchema.parse(input.state)
      await db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(ExternalMcpConnectionTable)
          .where(and(
            eq(ExternalMcpConnectionTable.id, this.connection.id),
            eq(ExternalMcpConnectionTable.organizationId, this.connection.organizationId),
          ))
          .limit(1)
          .for("update")
        const connection = rows[0]
        if (!connection) throw new Error("The enterprise MCP connection no longer exists.")
        this.assertCurrentIdentity(connection)
        assertCommitActive(input.context)
        const configuration: ExternalMcpOAuthConfiguration = connection.oauthConfiguration ?? {
          version: 1,
          authorizationServerIssuer: null,
          requestedScopes: [],
          callbackMode: "legacy-v1",
        }
        await tx
          .update(ExternalMcpConnectionTable)
          .set({
            oauthConfiguration: {
              ...configuration,
              authorizationServerIssuer: configuration.authorizationServerIssuer ?? state.authorizationServerUrl,
              discovery: state,
            },
          })
          .where(eq(ExternalMcpConnectionTable.id, connection.id))
        assertCommitActive(input.context)
      })
      await this.refreshConnection()
    },

    invalidate: async (input: {
      context: EnterpriseMcpPersistenceContext
      reason: "issuer-mismatch" | "provider-rejected"
    }): Promise<void> => {
      await db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(ExternalMcpConnectionTable)
          .where(and(
            eq(ExternalMcpConnectionTable.id, this.connection.id),
            eq(ExternalMcpConnectionTable.organizationId, this.connection.organizationId),
          ))
          .limit(1)
          .for("update")
        const connection = rows[0]
        if (!connection?.oauthConfiguration) return
        this.assertCurrentIdentity(connection)
        assertCommitActive(input.context)
        const { discovery: _discovery, ...configuration } = connection.oauthConfiguration
        await tx
          .update(ExternalMcpConnectionTable)
          .set({
            oauthConfiguration: configuration,
            ...(input.reason === "issuer-mismatch"
              ? { oauthIssuerReviewRequiredAt: new Date() }
              : {}),
          })
          .where(eq(ExternalMcpConnectionTable.id, connection.id))
        assertCommitActive(input.context)
      })
      await this.refreshConnection()
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
        if (!connection) throw new Error("The enterprise MCP connection no longer exists.")
        this.assertCurrentIdentity(connection)
        assertCommitActive(input.context)
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
        const existingValue = this.isPerMember ? account?.pendingCodeVerifier : connection.pendingCodeVerifier
        const transactions = parsePendingAuthorizations(existingValue)
          .filter((transaction) => transaction.expiresAt > Date.now() && transaction.idHash !== stateHash(input.id))
        if (transactions.length >= MAX_PENDING_AUTHORIZATIONS) {
          throw new Error(`At most ${MAX_PENDING_AUTHORIZATIONS} pending OAuth authorizations are allowed per connection identity.`)
        }
        transactions.push({
          idHash: stateHash(input.id),
          revision: randomUUID(),
          codeVerifier: input.codeVerifier,
          expiresAt: input.expiresAt,
          clientRegistrationRevision: input.clientRegistrationRevision,
        })
        const pendingCodeVerifier = serializePendingAuthorizations(transactions)
        if (this.isPerMember && this.member) {
          if (account) {
            await tx
              .update(ConnectedAccountTable)
              .set({ pendingCodeVerifier })
              .where(eq(ConnectedAccountTable.id, account.id))
          } else {
            await tx.insert(ConnectedAccountTable).values({
              id: createDenTypeId("connectedAccount"),
              organizationId: this.connection.organizationId,
              orgMembershipId: this.member.orgMembershipId,
              providerId: this.connection.id,
              pendingCodeVerifier,
            })
          }
        } else {
          await tx
            .update(ExternalMcpConnectionTable)
            .set({ pendingCodeVerifier })
            .where(eq(ExternalMcpConnectionTable.id, connection.id))
        }
        assertCommitActive(input.context)
      })
      await this.refreshConnection()
    },

    load: async (input: {
      context: EnterpriseMcpPersistenceContext
      id: string
    }): Promise<{ handle: EnterpriseMcpOAuthAuthorizationHandle; codeVerifier: string } | undefined> => {
      assertCommitActive(input.context)
      await this.refreshConnection()
      const account = this.isPerMember ? await this.memberAccount() : null
      const transaction = parsePendingAuthorizations(
        this.isPerMember ? account?.pendingCodeVerifier : this.connection.pendingCodeVerifier,
      ).find((candidate) => candidate.idHash === stateHash(input.id))
      if (!transaction) return undefined
      return {
        handle: {
          id: input.id,
          revision: transaction.revision,
          expiresAt: transaction.expiresAt,
          clientRegistrationRevision: transaction.clientRegistrationRevision,
        },
        codeVerifier: transaction.codeVerifier,
      }
    },

    invalidate: async (input: {
      context: EnterpriseMcpPersistenceContext
      id: string
      reason: "expired" | "abandoned" | "provider-rejected"
    }): Promise<void> => {
      await this.removeAuthorization(input.context, input.id)
    },
  }

  readonly credentials = {
    load: async (context: EnterpriseMcpPersistenceContext) => {
      assertCommitActive(context)
      await this.refreshConnection()
      if (this.isPerMember) {
        const account = await this.memberAccount()
        if (!account?.accessToken) return undefined
        return {
          tokens: {
            access_token: account.accessToken,
            token_type: account.tokenType ?? "Bearer",
            refresh_token: account.refreshToken ?? undefined,
            scope: account.scopes?.join(" ") ?? undefined,
          },
          expiresAt: account.expiresAt?.getTime(),
          revision: `${account.id}:${account.updatedAt.getTime()}`,
        }
      }
      if (!this.connection.accessToken) return undefined
      return {
        tokens: {
          access_token: this.connection.accessToken,
          token_type: this.connection.tokenType ?? "Bearer",
          refresh_token: this.connection.refreshToken ?? undefined,
          scope: this.connection.scope ?? undefined,
        },
        expiresAt: this.connection.expiresAt?.getTime(),
        revision: `${this.connection.id}:${this.connection.updatedAt.getTime()}`,
      }
    },

    save: async (input: {
      context: EnterpriseMcpPersistenceContext
      tokens: OAuthTokens
      expiresAt?: number
      source: "authorization-code" | "refresh"
      authorization?: EnterpriseMcpOAuthAuthorizationHandle
      clientRegistrationRevision?: string
      expectedCredentialRevision?: string
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
        if (!connection) throw new Error("The enterprise MCP connection no longer exists.")
        this.assertCurrentIdentity(connection)
        assertCommitActive(input.context)
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
        if (input.source === "refresh") {
          const currentCredentialRevision = this.isPerMember
            ? (account ? `${account.id}:${account.updatedAt.getTime()}` : undefined)
            : `${connection.id}:${connection.updatedAt.getTime()}`
          if (
            !input.expectedCredentialRevision
            || input.expectedCredentialRevision !== currentCredentialRevision
          ) {
            throw new EnterpriseMcpOAuthContractError(
              "MCP_OAUTH_CREDENTIAL_CHANGED",
              "The OAuth credential changed while refresh was in progress; retry with the newer credential.",
            )
          }
        }
        let pendingCodeVerifier = this.isPerMember ? account?.pendingCodeVerifier : connection.pendingCodeVerifier
        if (input.source === "authorization-code") {
          const authorization = input.authorization
          if (!authorization) throw new Error("An authorization-code token commit requires its transaction handle.")
          const transactions = parsePendingAuthorizations(pendingCodeVerifier)
          const transaction = transactions.find((candidate) => candidate.idHash === stateHash(authorization.id))
          if (
            !transaction
            || transaction.revision !== authorization.revision
            || transaction.expiresAt <= Date.now()
          ) throw new Error("The OAuth authorization is missing, expired, or already consumed.")
          if (transaction.clientRegistrationRevision !== input.clientRegistrationRevision) {
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
          pendingCodeVerifier = serializePendingAuthorizations(
            transactions.filter((candidate) => candidate.revision !== transaction.revision),
          )
        }
        const expiresAt = input.expiresAt === undefined ? null : new Date(input.expiresAt)
        const updatedAt = new Date(Math.max(
          Date.now(),
          (this.isPerMember ? account?.updatedAt.getTime() : connection.updatedAt.getTime()) ?? 0,
        ) + 1)
        const connectedAt = account
          ? new Date(Math.max(Date.now(), account.connectedAt.getTime() + 1))
          : new Date()
        if (this.isPerMember && this.member) {
          if (account) {
            await tx
              .update(ConnectedAccountTable)
              .set({
                accessToken: input.tokens.access_token,
                refreshToken: input.tokens.refresh_token ?? account.refreshToken ?? null,
                tokenType: input.tokens.token_type ?? null,
                scopes: input.tokens.scope ? input.tokens.scope.split(" ") : null,
                expiresAt,
                pendingCodeVerifier,
                credentialHealth: credentialHealth("ready", null),
                updatedAt,
                ...(input.source === "authorization-code" ? { connectedAt } : {}),
              })
              .where(eq(ConnectedAccountTable.id, account.id))
          } else {
            await tx.insert(ConnectedAccountTable).values({
              id: createDenTypeId("connectedAccount"),
              organizationId: this.connection.organizationId,
              orgMembershipId: this.member.orgMembershipId,
              providerId: this.connection.id,
              accessToken: input.tokens.access_token,
              refreshToken: input.tokens.refresh_token ?? null,
              tokenType: input.tokens.token_type ?? null,
              scopes: input.tokens.scope ? input.tokens.scope.split(" ") : null,
              expiresAt,
              pendingCodeVerifier,
              credentialHealth: credentialHealth("ready", null),
            })
          }
        } else {
          await tx
            .update(ExternalMcpConnectionTable)
            .set({
              accessToken: input.tokens.access_token,
              refreshToken: input.tokens.refresh_token ?? connection.refreshToken ?? null,
              tokenType: input.tokens.token_type ?? null,
              scope: input.tokens.scope ?? null,
              expiresAt,
              pendingCodeVerifier,
              credentialHealth: credentialHealth("ready", null),
              updatedAt,
              connectedAt: new Date(),
            })
            .where(eq(ExternalMcpConnectionTable.id, connection.id))
        }
        // Throwing here rolls back the token write and authorization consume.
        assertCommitActive(input.context)
      })
      await this.refreshConnection()
    },

    invalidate: async (input: {
      context: EnterpriseMcpPersistenceContext
      reason: "expired" | "provider-rejected" | "post-authorization-validation-failed"
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
          await tx
            .update(ConnectedAccountTable)
            .set({
              accessToken: null,
              refreshToken: null,
              tokenType: null,
              scopes: null,
              expiresAt: null,
              credentialHealth: invalidCredentialHealth(input.reason),
            })
            .where(and(
              eq(ConnectedAccountTable.organizationId, this.connection.organizationId),
              eq(ConnectedAccountTable.orgMembershipId, this.member.orgMembershipId),
              eq(ConnectedAccountTable.providerId, this.connection.id),
            ))
        } else {
          await tx
            .update(ExternalMcpConnectionTable)
            .set({
              accessToken: null,
              refreshToken: null,
              tokenType: null,
              scope: null,
              expiresAt: null,
              connectedAt: null,
              credentialHealth: invalidCredentialHealth(input.reason),
            })
            .where(eq(ExternalMcpConnectionTable.id, connection.id))
        }
        assertCommitActive(input.context)
      })
      await this.refreshConnection()
    },
  }

  private async removeAuthorization(context: EnterpriseMcpPersistenceContext, id: string): Promise<void> {
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
      const pendingCodeVerifier = serializePendingAuthorizations(
        parsePendingAuthorizations(existing).filter((transaction) => transaction.idHash !== stateHash(id)),
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
    })
    await this.refreshConnection()
  }
}
