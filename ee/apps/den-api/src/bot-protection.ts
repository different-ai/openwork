import { checkBotId } from "botid/server"
import type { Context } from "hono"
import { decideBotProtection, type BotProtectionResult } from "./bot-protection-policy.js"
import { env } from "./env.js"

export type { BotProtectionResult } from "./bot-protection-policy.js"

export async function verifyMcpOAuthQuery(oauthQuery: string) {
  const clientId = new URLSearchParams(oauthQuery).get("client_id")
  if (!clientId) return false
  // Better Auth's prelogin endpoint verifies the HMAC signature and expiry of
  // the authorize query it issued; it throws when either check fails.
  const { auth } = await import("./auth.js")
  await auth.api.getOAuthClientPublicPrelogin({ body: { client_id: clientId, oauth_query: oauthQuery } })
  return true
}

async function isPendingDeviceUserCode(userCode: string) {
  const { lookupDeviceUserCode } = await import("./device-authorization.js")
  const lookup = await lookupDeviceUserCode(userCode)
  return lookup.ok && lookup.status === "pending"
}

async function isPendingClaimUserCode(userCode: string) {
  const { lookupClaimCode } = await import("./workspace-preclaim.js")
  const lookup = await lookupClaimCode(userCode)
  return lookup.ok
}

// The session middleware has already resolved cookie, bearer, and API key
// callers into c.get("user") for every route, including public ones.
function readAuthenticatedUserId(c: Context) {
  const user: unknown = c.get("user")
  if (user && typeof user === "object" && "id" in user && typeof user.id === "string" && user.id) {
    return user.id
  }
  return null
}

export async function verifyBotProtection(c: Context): Promise<BotProtectionResult> {
  // BotID enforcement stays off by default until Den Web initializes the
  // BotID client on the browser-facing proxy routes. Without it,
  // checkBotId() cannot pass and every browser sign-in would be rejected.
  return decideBotProtection(
    { headers: c.req.raw.headers, authenticatedUserId: readAuthenticatedUserId(c) },
    {
      enabled: !env.devMode && env.botIdProtectionEnabled,
      checkBotId,
      verifyMcpOAuthQuery,
      isPendingDeviceUserCode,
      isPendingClaimUserCode,
    },
  )
}
