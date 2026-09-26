import { createHash, createHmac, randomBytes } from "node:crypto"
import { and, desc, eq, gt, inArray, isNull } from "@openwork-ee/den-db/drizzle"
import {
  AuthSessionTable,
  AuthUserTable,
  OrganizationTable,
  WorkspaceBootstrapTable,
  WorkspaceClaimCodeTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { SignJWT, jwtVerify } from "jose"
import {
  auth,
  DEN_MCP_OAUTH_RESOURCE,
  DEN_MCP_ORG_ID_CLAIM,
  DEN_MCP_RESOURCE_CLAIM,
  DEN_MCP_TOKEN_USE_CLAIM,
} from "./auth.js"
import { cache } from "./cache.js"
import { db } from "./db.js"
import { env } from "./env.js"
import { getDenAuthIssuer } from "./mcp/jwt-policy.js"

/**
 * "Provision now, claim later" for agent-created workspaces.
 *
 * `POST /v1/bootstrap/workspace` creates a sign-in-less agent user as the
 * setup member and returns a pre-claim identity assertion (a signed JWT bound
 * to that workspace and to Den's token endpoint). The agent exchanges it with
 * the RFC 7523 JWT-bearer grant for a short-lived MCP access token that only
 * carries pre-claim capabilities. A person later claims the workspace with an
 * RFC 8628-style user code; the claim revokes the assertion and every token
 * minted from it.
 *
 * The assertion and the tokens are bearer secrets. Never log them.
 */

export const JWT_BEARER_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:jwt-bearer"
export const PRECLAIM_ASSERTION_TYPE = "openwork-preclaim+jwt"
export const PRECLAIM_SCOPE = "mcp:read mcp:write"
export const PRECLAIM_ACCESS_TOKEN_TTL_SECONDS = 15 * 60
export const CLAIM_CODE_TTL_SECONDS = 15 * 60
export const CLAIM_CODE_POLL_INTERVAL_SECONDS = 5
/** Reserved domain: agent users can never receive mail or sign in. */
export const PRECLAIM_AGENT_EMAIL_DOMAIN = "agents.openwork.invalid"
export const PRECLAIM_CLIENT_ID = "openwork-preclaim"

const USER_CODE_CHARSET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

function assertionKey(): Uint8Array {
  // Derived so the raw Better Auth secret never signs anything else here.
  return new Uint8Array(createHmac("sha256", env.betterAuthSecret).update("openwork:preclaim-assertion:v1").digest())
}

export function preclaimIssuer(): string {
  return getDenAuthIssuer(env.betterAuthUrl)
}

/** The only audience an assertion is valid for: Den's OAuth token endpoint. */
export function preclaimAssertionAudience(): string {
  return `${preclaimIssuer()}/oauth2/token`
}

export function preclaimAgentEmail(bootstrapId: string): string {
  return `agent+${bootstrapId}@${PRECLAIM_AGENT_EMAIL_DOMAIN}`
}

export function isPreclaimAgentEmail(email: string | null | undefined): boolean {
  return typeof email === "string" && email.toLowerCase().endsWith(`@${PRECLAIM_AGENT_EMAIL_DOMAIN}`)
}

export function claimVerificationUri(): string {
  return `${env.betterAuthUrl}/claim`
}

export function hashClaimUserCode(userCode: string): string {
  return createHash("sha256").update(normalizeClaimUserCode(userCode)).digest("hex")
}

export function normalizeClaimUserCode(userCode: string): string {
  return userCode.replace(/[\s-]/g, "").toUpperCase()
}

function generateUserCode(): string {
  const bytes = randomBytes(8)
  return Array.from(bytes, (byte) => USER_CODE_CHARSET[byte % USER_CODE_CHARSET.length]).join("")
}

export async function signPreclaimAssertion(input: {
  bootstrapId: string
  organizationId: string
  agentUserId: string
  jti: string
  expiresAt: Date
}): Promise<string> {
  return await new SignJWT({ [DEN_MCP_ORG_ID_CLAIM]: input.organizationId, bid: input.bootstrapId })
    .setProtectedHeader({ alg: "HS256", typ: PRECLAIM_ASSERTION_TYPE })
    .setIssuer(preclaimIssuer())
    .setAudience(preclaimAssertionAudience())
    .setSubject(input.agentUserId)
    .setJti(input.jti)
    .setIssuedAt()
    .setExpirationTime(Math.floor(input.expiresAt.getTime() / 1000))
    .sign(assertionKey())
}

type BootstrapRow = typeof WorkspaceBootstrapTable.$inferSelect

export type PreclaimAssertionCheck =
  | { ok: true; bootstrap: BootstrapRow; revoked: boolean }
  | { ok: false; error: "invalid_grant"; description: string }

/**
 * Verify signature, audience, issuer, expiry, and that the jti is the one the
 * workspace still recognizes. `revoked` reports a claimed/expired workspace so
 * callers that only report claim state can still answer.
 */
export async function verifyPreclaimAssertion(assertion: string, now = new Date()): Promise<PreclaimAssertionCheck> {
  let payload: Record<string, unknown>
  try {
    const verified = await jwtVerify(assertion, assertionKey(), {
      algorithms: ["HS256"],
      issuer: preclaimIssuer(),
      audience: preclaimAssertionAudience(),
      typ: PRECLAIM_ASSERTION_TYPE,
      currentDate: now,
    })
    payload = verified.payload
  } catch {
    return { ok: false, error: "invalid_grant", description: "The assertion is invalid or expired." }
  }
  const bootstrapId = typeof payload.bid === "string" ? payload.bid : null
  const jti = typeof payload.jti === "string" ? payload.jti : null
  if (!bootstrapId || !jti) {
    return { ok: false, error: "invalid_grant", description: "The assertion is missing its workspace." }
  }
  let normalizedBootstrapId: string
  try {
    normalizedBootstrapId = normalizeDenTypeId("workspaceBootstrap", bootstrapId)
  } catch {
    return { ok: false, error: "invalid_grant", description: "The assertion is missing its workspace." }
  }
  const [bootstrap] = await db
    .select()
    .from(WorkspaceBootstrapTable)
    .where(eq(WorkspaceBootstrapTable.id, normalizeDenTypeId("workspaceBootstrap", normalizedBootstrapId)))
    .limit(1)
  if (!bootstrap || bootstrap.assertionJti !== jti || bootstrap.agentUserId !== payload.sub) {
    return { ok: false, error: "invalid_grant", description: "The assertion is not recognized." }
  }
  const revoked = bootstrap.status !== "provisional" || bootstrap.credentialsRevokedAt !== null || bootstrap.expiresAt <= now
  return { ok: true, bootstrap, revoked }
}

export type PreclaimTokenResponse = {
  access_token: string
  token_type: "Bearer"
  expires_in: number
  scope: string
}

export type JwtBearerResult =
  | { ok: true; body: PreclaimTokenResponse }
  | { ok: false; status: 400; body: { error: "invalid_grant" | "invalid_request"; error_description: string } }

/**
 * RFC 7523 JWT-bearer grant: trade a live pre-claim assertion for a
 * short-lived MCP access token for the workspace's agent user. No refresh
 * token is issued; the agent re-exchanges the assertion instead.
 */
export async function exchangePreclaimAssertion(assertion: string, now = new Date()): Promise<JwtBearerResult> {
  const checked = await verifyPreclaimAssertion(assertion, now)
  if (!checked.ok) {
    return { ok: false, status: 400, body: { error: checked.error, error_description: checked.description } }
  }
  if (checked.revoked || !checked.bootstrap.agentUserId) {
    return { ok: false, status: 400, body: { error: "invalid_grant", error_description: "This workspace was claimed or expired; its pre-claim credentials are revoked." } }
  }
  const { bootstrap } = checked
  const agentUserId = normalizeDenTypeId("user", bootstrap.agentUserId ?? "")
  const expiresAt = new Date(Math.min(now.getTime() + PRECLAIM_ACCESS_TOKEN_TTL_SECONDS * 1000, bootstrap.expiresAt.getTime()))
  const sessionId = createDenTypeId("session")
  await db.insert(AuthSessionTable).values({
    id: sessionId,
    userId: agentUserId,
    activeOrganizationId: bootstrap.organizationId,
    token: randomBytes(32).toString("base64url"),
    expiresAt,
    ipAddress: null,
    userAgent: "openwork-preclaim",
  })
  const issuedAt = Math.floor(now.getTime() / 1000)
  const exp = Math.floor(expiresAt.getTime() / 1000)
  const signed = await auth.api.signJWT({
    body: {
      payload: {
        sub: agentUserId,
        aud: DEN_MCP_OAUTH_RESOURCE,
        azp: PRECLAIM_CLIENT_ID,
        client_id: PRECLAIM_CLIENT_ID,
        scope: PRECLAIM_SCOPE,
        sid: sessionId,
        iat: issuedAt,
        exp,
        [DEN_MCP_TOKEN_USE_CLAIM]: "mcp",
        [DEN_MCP_RESOURCE_CLAIM]: DEN_MCP_OAUTH_RESOURCE,
        [DEN_MCP_ORG_ID_CLAIM]: bootstrap.organizationId,
      },
    },
  })
  return {
    ok: true,
    body: { access_token: signed.token, token_type: "Bearer", expires_in: Math.max(1, exp - issuedAt), scope: PRECLAIM_SCOPE },
  }
}

/** Returns the provisional workspace this user acts for, or null for everyone else. */
export async function findPreclaimWorkspaceForUser(input: { userId: string; email?: string | null }) {
  if (input.email !== undefined && !isPreclaimAgentEmail(input.email)) return null
  let userId: string
  try {
    userId = normalizeDenTypeId("user", input.userId)
  } catch {
    return null
  }
  const [row] = await db
    .select({ id: WorkspaceBootstrapTable.id, organizationId: WorkspaceBootstrapTable.organizationId, status: WorkspaceBootstrapTable.status })
    .from(WorkspaceBootstrapTable)
    .where(eq(WorkspaceBootstrapTable.agentUserId, normalizeDenTypeId("user", userId)))
    .limit(1)
  return row ?? null
}

export type RequiresClaimError = {
  code: "requires_claim"
  message: string
  retryable: false
  claim_url: string
}

export function requiresClaimError(action: string): RequiresClaimError {
  return {
    code: "requires_claim",
    message: `${action} needs a person to claim this workspace first. Create a claim code with POST /v1/bootstrap/workspace/{id}/claim and give the person the link.`,
    retryable: false,
    claim_url: claimVerificationUri(),
  }
}

type PreclaimRequest = { method: string; path: string; readJson: () => Promise<unknown> }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/**
 * Pre-claim capabilities, as an allowlist. Reads are allowed; writes are
 * limited to skills, plugins, marketplaces, install links, and member-level
 * MCP connections that need no sign-in. Everything else (billing,
 * invitations, members, roles, shared credentials, AI providers, SSO, SCIM,
 * API keys) needs a person, so it returns `requires_claim`.
 */
export async function preclaimActionAllowed(request: PreclaimRequest): Promise<boolean> {
  const method = request.method.toUpperCase()
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return true
  const path = request.path
  if (/^\/v1\/(config-objects|plugins|marketplaces)(\/|$)/.test(path)) return true
  if (/^\/v1\/orgs\/[^/]+\/install-links$/.test(path) && method === "POST") return true
  if (path === "/v1/mcp-connections" && method === "POST") {
    const body = await request.readJson().catch(() => null)
    return isRecord(body) && body.authType === "none" && body.credentialMode === "per_member"
  }
  return false
}

export type ClaimCodeIssue = {
  user_code: string
  verification_uri: string
  verification_uri_complete: string
  expires_in: number
  interval: number
}

/** Mint a claim code, cancelling any earlier code that was never used. */
export async function issueClaimCode(bootstrap: BootstrapRow, now = new Date()): Promise<ClaimCodeIssue> {
  const userCode = generateUserCode()
  await db.transaction(async (tx) => {
    await tx
      .update(WorkspaceClaimCodeTable)
      .set({ state: "cancelled" })
      .where(and(eq(WorkspaceClaimCodeTable.bootstrapId, bootstrap.id), eq(WorkspaceClaimCodeTable.state, "pending")))
    await tx.insert(WorkspaceClaimCodeTable).values({
      id: createDenTypeId("workspaceClaimCode"),
      bootstrapId: bootstrap.id,
      organizationId: bootstrap.organizationId,
      userCodeHash: hashClaimUserCode(userCode),
      state: "pending",
      expiresAt: new Date(now.getTime() + CLAIM_CODE_TTL_SECONDS * 1000),
    })
  })
  const display = `${userCode.slice(0, 4)}-${userCode.slice(4)}`
  return {
    user_code: display,
    verification_uri: claimVerificationUri(),
    verification_uri_complete: `${claimVerificationUri()}?user_code=${encodeURIComponent(display)}`,
    expires_in: CLAIM_CODE_TTL_SECONDS,
    interval: CLAIM_CODE_POLL_INTERVAL_SECONDS,
  }
}

export type ClaimState = { state: "none" | "pending" | "expired" | "accepted" | "reconciled"; reconciled: boolean }

export async function readClaimState(bootstrap: BootstrapRow, now = new Date()): Promise<ClaimState> {
  const [latest] = await db
    .select({ state: WorkspaceClaimCodeTable.state, expiresAt: WorkspaceClaimCodeTable.expiresAt })
    .from(WorkspaceClaimCodeTable)
    .where(and(eq(WorkspaceClaimCodeTable.bootstrapId, bootstrap.id), inArray(WorkspaceClaimCodeTable.state, ["pending", "accepted", "reconciled"])))
    .orderBy(desc(WorkspaceClaimCodeTable.createdAt))
    .limit(1)
  if (bootstrap.status === "claimed" && bootstrap.credentialsRevokedAt) {
    return { state: "reconciled", reconciled: true }
  }
  if (!latest) return { state: "none", reconciled: false }
  if (latest.state === "pending" && latest.expiresAt <= now) return { state: "expired", reconciled: false }
  if (latest.state === "accepted") return { state: "accepted", reconciled: false }
  if (latest.state === "reconciled") return { state: "reconciled", reconciled: true }
  return { state: "pending", reconciled: false }
}

export type ClaimCodeLookup =
  | { ok: true; bootstrapId: string; organizationId: string; organizationName: string; setupMemberId: string; codeId: string }
  | { ok: false; error: "invalid_user_code" }

export async function lookupClaimCode(userCode: string, now = new Date()): Promise<ClaimCodeLookup> {
  const [row] = await db
    .select({
      codeId: WorkspaceClaimCodeTable.id,
      bootstrapId: WorkspaceClaimCodeTable.bootstrapId,
      organizationId: WorkspaceClaimCodeTable.organizationId,
      organizationName: OrganizationTable.name,
      setupMemberId: WorkspaceBootstrapTable.setupMemberId,
    })
    .from(WorkspaceClaimCodeTable)
    .innerJoin(WorkspaceBootstrapTable, eq(WorkspaceClaimCodeTable.bootstrapId, WorkspaceBootstrapTable.id))
    .innerJoin(OrganizationTable, eq(WorkspaceClaimCodeTable.organizationId, OrganizationTable.id))
    .where(and(
      eq(WorkspaceClaimCodeTable.userCodeHash, hashClaimUserCode(userCode)),
      eq(WorkspaceClaimCodeTable.state, "pending"),
      gt(WorkspaceClaimCodeTable.expiresAt, now),
      eq(WorkspaceBootstrapTable.status, "provisional"),
      gt(WorkspaceBootstrapTable.expiresAt, now),
    ))
    .limit(1)
  if (!row) return { ok: false, error: "invalid_user_code" }
  return { ok: true, ...row }
}

/**
 * End every pre-claim credential for a workspace: the assertion stops
 * exchanging (credentialsRevokedAt) and each agent session behind an MCP
 * token is deleted, so already-minted tokens fail session liveness.
 */
export async function revokePreclaimCredentials(bootstrapId: string, now = new Date()): Promise<void> {
  const [bootstrap] = await db
    .select({ agentUserId: WorkspaceBootstrapTable.agentUserId })
    .from(WorkspaceBootstrapTable)
    .where(eq(WorkspaceBootstrapTable.id, normalizeDenTypeId("workspaceBootstrap", bootstrapId)))
    .limit(1)
  await db
    .update(WorkspaceBootstrapTable)
    .set({ credentialsRevokedAt: now })
    .where(and(eq(WorkspaceBootstrapTable.id, normalizeDenTypeId("workspaceBootstrap", bootstrapId)), isNull(WorkspaceBootstrapTable.credentialsRevokedAt)))
  if (!bootstrap?.agentUserId) return
  const agentUserId = normalizeDenTypeId("user", bootstrap.agentUserId)
  const sessions = await db
    .select({ id: AuthSessionTable.id, token: AuthSessionTable.token })
    .from(AuthSessionTable)
    .where(eq(AuthSessionTable.userId, agentUserId))
  await db.delete(AuthSessionTable).where(eq(AuthSessionTable.userId, agentUserId))
  for (const session of sessions) {
    await cache.auth.revokeSession(session.token)
    await cache.auth.revokeSessionId(normalizeDenTypeId("session", session.id))
  }
}

/** Create the sign-in-less agent user that acts as the setup member. */
export function agentUserValues(bootstrapId: string) {
  return {
    id: createDenTypeId("user"),
    name: "Setup agent",
    email: preclaimAgentEmail(bootstrapId),
    emailVerified: false,
  } satisfies typeof AuthUserTable.$inferInsert
}
