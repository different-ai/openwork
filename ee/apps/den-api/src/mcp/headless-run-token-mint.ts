import * as crypto from "node:crypto"
import { and, eq, lt } from "@openwork-ee/den-db/drizzle"
import { OAuthAccessTokenTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { DEN_MCP_OPAQUE_ACCESS_TOKEN_PREFIX } from "../auth.js"
import { db } from "../db.js"
import { hashOpaqueMcpSecret } from "./auth.js"
import { DEN_MCP_HEADLESS_RUN_CLIENT_ID, DEN_MCP_HEADLESS_RUN_TOKEN_MAX_TTL_MS } from "./headless-run-token.js"
import { DEN_MCP_APP_HOST_SCOPE, DEN_MCP_READ_SCOPE, DEN_MCP_WRITE_SCOPE } from "./scopes.js"

/**
 * Mints a member-scoped MCP token for one headless run. Only trusted server
 * code that has already authorized the member for this run may call it; the
 * token is handed to the headless runner for that run and never stored.
 * `appHost` mints Workbot's server its MCP Apps host token instead (reads an
 * App's page and runs its tools on the connection that opened it); it never
 * reaches the runner or a browser.
 */
export async function mintHeadlessRunMcpToken(input: { userId: string; organizationId: string; ttlMs?: number; readOnly?: boolean; appHost?: boolean }) {
  const ttlMs = Math.min(input.ttlMs ?? DEN_MCP_HEADLESS_RUN_TOKEN_MAX_TTL_MS, DEN_MCP_HEADLESS_RUN_TOKEN_MAX_TTL_MS)
  const secret = crypto.randomBytes(32).toString("base64url")
  const now = new Date()
  const expiresAt = new Date(now.getTime() + ttlMs)
  const id = createDenTypeId("oauthAccessToken")
  // Expired run tokens are useless; drop them so they don't accumulate.
  await db
    .delete(OAuthAccessTokenTable)
    .where(and(eq(OAuthAccessTokenTable.clientId, DEN_MCP_HEADLESS_RUN_CLIENT_ID), lt(OAuthAccessTokenTable.expiresAt, now)))
  await db.insert(OAuthAccessTokenTable).values({
    id,
    token: hashOpaqueMcpSecret(secret),
    clientId: DEN_MCP_HEADLESS_RUN_CLIENT_ID,
    sessionId: null,
    userId: normalizeDenTypeId("user", input.userId),
    referenceId: normalizeDenTypeId("organization", input.organizationId),
    createdAt: now,
    expiresAt,
    scopes: JSON.stringify(
      input.appHost
        ? [DEN_MCP_READ_SCOPE, DEN_MCP_WRITE_SCOPE, DEN_MCP_APP_HOST_SCOPE]
        : input.readOnly
          ? [DEN_MCP_READ_SCOPE]
          : [DEN_MCP_READ_SCOPE, DEN_MCP_WRITE_SCOPE],
    ),
  })
  return { token: `${DEN_MCP_OPAQUE_ACCESS_TOKEN_PREFIX}${secret}`, tokenId: id, expiresAt }
}

export async function revokeHeadlessRunMcpToken(tokenId: string) {
  await db
    .delete(OAuthAccessTokenTable)
    .where(and(eq(OAuthAccessTokenTable.id, normalizeDenTypeId("oauthAccessToken", tokenId)), eq(OAuthAccessTokenTable.clientId, DEN_MCP_HEADLESS_RUN_CLIENT_ID)))
}
