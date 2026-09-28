import { expect, test } from "bun:test"
import {
  CLAIM_USER_CODE_HEADER,
  DEVICE_USER_CODE_HEADER,
  MCP_OAUTH_QUERY_HEADER,
  decideBotProtection,
  type BotProtectionDeps,
} from "../src/bot-protection-policy.js"

const VALID_OAUTH_QUERY = "client_id=agent&exp=9999999999&sig=valid"
const PENDING_DEVICE_CODE = "ABCD2345"
const PENDING_CLAIM_CODE = "WXYZ6789"

function deps(overrides: Partial<BotProtectionDeps> = {}) {
  let botIdCalls = 0
  const value: BotProtectionDeps = {
    enabled: true,
    // Plain requests without the BotID browser client are flagged.
    checkBotId: async () => {
      botIdCalls += 1
      return { isBot: true }
    },
    verifyMcpOAuthQuery: async (query) => query === VALID_OAUTH_QUERY,
    isPendingDeviceUserCode: async (code) => code === PENDING_DEVICE_CODE,
    isPendingClaimUserCode: async (code) => code === PENDING_CLAIM_CODE,
    ...overrides,
  }
  return { value, botIdCalls: () => botIdCalls }
}

function request(headers: Record<string, string> = {}, authenticatedUserId: string | null = null) {
  return { headers: new Headers(headers), authenticatedUserId }
}

const REJECTED = { ok: false, status: 403, message: "Request verification failed." }

test("flag off skips BotID entirely", async () => {
  const d = deps({ enabled: false })
  expect(await decideBotProtection(request(), d.value)).toEqual({ ok: true, reason: "disabled" })
  expect(d.botIdCalls()).toBe(0)
})

test("plain browser sign-in flagged by BotID is rejected", async () => {
  const d = deps()
  expect(await decideBotProtection(request({ "user-agent": "Mozilla/5.0" }), d.value)).toEqual(REJECTED)
  expect(d.botIdCalls()).toBe(1)
})

test("browser that passes BotID is allowed", async () => {
  const d = deps({ checkBotId: async () => ({ isBot: false }) })
  expect(await decideBotProtection(request(), d.value)).toEqual({ ok: true, reason: "botid" })
})

test("BotID errors fail closed", async () => {
  const d = deps({ checkBotId: async () => { throw new Error("misconfigured") } })
  expect(await decideBotProtection(request(), d.value)).toEqual(REJECTED)
})

test("MCP OAuth sign-up with a valid signed query is allowed without BotID", async () => {
  const d = deps()
  expect(await decideBotProtection(request({ [MCP_OAUTH_QUERY_HEADER]: VALID_OAUTH_QUERY }), d.value))
    .toEqual({ ok: true, reason: "mcp_oauth" })
  expect(d.botIdCalls()).toBe(0)
})

test("a tampered or expired OAuth query falls back to BotID", async () => {
  const d = deps({ verifyMcpOAuthQuery: async () => { throw new Error("invalid_signature") } })
  expect(await decideBotProtection(request({ [MCP_OAUTH_QUERY_HEADER]: "client_id=agent&sig=forged" }), d.value)).toEqual(REJECTED)
  expect(d.botIdCalls()).toBe(1)
})

test("bearer or API key callers are allowed without BotID", async () => {
  const d = deps()
  expect(await decideBotProtection(request({ authorization: "Bearer token" }, "user_123"), d.value))
    .toEqual({ ok: true, reason: "authenticated" })
  expect(d.botIdCalls()).toBe(0)
})

test("an unverified Authorization header alone does not bypass BotID", async () => {
  const d = deps()
  expect(await decideBotProtection(request({ authorization: "Bearer not-a-real-token" }), d.value)).toEqual(REJECTED)
})

test("pending device and claim codes are allowed; unknown codes are not", async () => {
  expect(await decideBotProtection(request({ [DEVICE_USER_CODE_HEADER]: PENDING_DEVICE_CODE }), deps().value))
    .toEqual({ ok: true, reason: "device_code" })
  expect(await decideBotProtection(request({ [CLAIM_USER_CODE_HEADER]: PENDING_CLAIM_CODE }), deps().value))
    .toEqual({ ok: true, reason: "claim_code" })
  expect(await decideBotProtection(request({ [DEVICE_USER_CODE_HEADER]: "NOPE0000" }), deps().value)).toEqual(REJECTED)
  expect(await decideBotProtection(request({ [CLAIM_USER_CODE_HEADER]: "NOPE0000" }), deps().value)).toEqual(REJECTED)
})

test("agent user agents alone are still rejected", async () => {
  for (const userAgent of ["Claude-User/1.0", "ChatGPT-User/1.0", "HeadlessChrome/120", "curl/8.4.0", "python-requests/2.31"]) {
    const d = deps()
    expect(await decideBotProtection(request({ "user-agent": userAgent }), d.value)).toEqual(REJECTED)
  }
})

test("oversized context headers are ignored", async () => {
  const d = deps({ verifyMcpOAuthQuery: async () => true })
  expect(await decideBotProtection(request({ [MCP_OAUTH_QUERY_HEADER]: "x".repeat(5000) }), d.value)).toEqual(REJECTED)
})
