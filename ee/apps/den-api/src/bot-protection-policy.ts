// Den Web pages that sign a person in on behalf of an agent send one of these
// so BotID does not block callers that cannot run the BotID browser client.
export const MCP_OAUTH_QUERY_HEADER = "x-openwork-oauth-query"
export const DEVICE_USER_CODE_HEADER = "x-openwork-device-user-code"
export const CLAIM_USER_CODE_HEADER = "x-openwork-claim-user-code"

const MAX_CONTEXT_HEADER_LENGTH = 4096

export type BotProtectionResult =
  | { ok: true; reason: "disabled" | "botid" | "authenticated" | "mcp_oauth" | "device_code" | "claim_code" }
  | { ok: false; status: 403; message: string }

export type BotProtectionRequest = {
  headers: Headers
  // Resolved by the session middleware from a cookie session, bearer token, or API key.
  authenticatedUserId: string | null
}

export type BotProtectionDeps = {
  enabled: boolean
  checkBotId: () => Promise<{ isBot: boolean }>
  // Each verifier must prove the value against server state or a server secret.
  verifyMcpOAuthQuery: (oauthQuery: string) => Promise<boolean>
  isPendingDeviceUserCode: (userCode: string) => Promise<boolean>
  isPendingClaimUserCode: (userCode: string) => Promise<boolean>
}

const REJECTED: BotProtectionResult = { ok: false, status: 403, message: "Request verification failed." }

function readContextHeader(headers: Headers, name: string) {
  const value = headers.get(name)?.trim() ?? ""
  return value && value.length <= MAX_CONTEXT_HEADER_LENGTH ? value : ""
}

async function safely(check: () => Promise<boolean>) {
  try {
    return await check()
  } catch {
    return false
  }
}

/**
 * BotID only works for requests from a browser running the BotID client. Agent
 * and API flows skip it only with a verified context: an authenticated caller,
 * a Better Auth-signed MCP OAuth query, or a live device/claim user code.
 * Headers such as User-Agent are never trusted. Rate limits still apply after.
 */
export async function decideBotProtection(
  request: BotProtectionRequest,
  deps: BotProtectionDeps,
): Promise<BotProtectionResult> {
  if (!deps.enabled) return { ok: true, reason: "disabled" }
  if (request.authenticatedUserId) return { ok: true, reason: "authenticated" }

  const oauthQuery = readContextHeader(request.headers, MCP_OAUTH_QUERY_HEADER)
  if (oauthQuery && await safely(() => deps.verifyMcpOAuthQuery(oauthQuery))) {
    return { ok: true, reason: "mcp_oauth" }
  }

  const deviceUserCode = readContextHeader(request.headers, DEVICE_USER_CODE_HEADER)
  if (deviceUserCode && await safely(() => deps.isPendingDeviceUserCode(deviceUserCode))) {
    return { ok: true, reason: "device_code" }
  }

  const claimUserCode = readContextHeader(request.headers, CLAIM_USER_CODE_HEADER)
  if (claimUserCode && await safely(() => deps.isPendingClaimUserCode(claimUserCode))) {
    return { ok: true, reason: "claim_code" }
  }

  try {
    const result = await deps.checkBotId()
    return result.isBot ? REJECTED : { ok: true, reason: "botid" }
  } catch {
    return REJECTED
  }
}
