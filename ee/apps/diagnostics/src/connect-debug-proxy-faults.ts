import type { ConnectDebugProxyScenario } from "./connect-debug-proxy-scenarios"
import { isAgentEndpoint, isTokenMintEndpoint } from "./connect-debug-proxy-scenarios"
import type { McpTamperMode } from "./connect-debug-proxy-tamper"

export type ConnectDebugProxyFaultAction =
  | { kind: "delay"; label: string; milliseconds: number }
  | { kind: "hang"; label: string }
  | { kind: "response"; label: string; response: Response }
  | { kind: "tamper"; label: string; mode: McpTamperMode }

type FlakyWindow = { count: number; startedAt: number }

declare global {
  var __openworkConnectDebugProxyFlakyWindows: Map<string, FlakyWindow> | undefined
}

const flakyWindows = globalThis.__openworkConnectDebugProxyFlakyWindows ??= new Map()

function jsonError(status: number, error: string, message: string, headers?: HeadersInit): Response {
  return Response.json({ error, message }, {
    headers: { "cache-control": "no-store", ...headers },
    status,
  })
}

function flakyRequestShouldFail(key: string, failures: number, windowMs: number, now: number): { count: number; fail: boolean } {
  const current = flakyWindows.get(key)
  const window = !current || now - current.startedAt >= windowMs
    ? { count: 0, startedAt: now }
    : current
  window.count += 1
  flakyWindows.set(key, window)
  return { count: window.count, fail: window.count <= failures }
}

export function connectDebugProxyFault(input: {
  flakyKey: string
  flakyWindowMs: number
  now: number
  pathname: string
  requestBody: Uint8Array | undefined
  scenario: ConnectDebugProxyScenario
  slowMs: number
}): ConnectDebugProxyFaultAction | null {
  const agent = isAgentEndpoint(input.pathname)
  if (input.scenario.fault === "den-outage") {
    return { kind: "response", label: "den-outage", response: jsonError(503, "den_outage", "The Den endpoint is unavailable in this debug scenario.") }
  }
  if (input.scenario.fault === "token-mint-fail" && isTokenMintEndpoint(input.pathname)) {
    return { kind: "response", label: "token-mint-fail", response: jsonError(503, "token_mint_failed", "Token minting is unavailable in this debug scenario.") }
  }
  if (!agent) return null
  if (input.scenario.fault === "auth-expired") {
    return {
      kind: "response",
      label: "auth-expired",
      response: jsonError(401, "invalid_token", "The debug scenario expired the OpenWork Connect token.", {
        "www-authenticate": "Bearer error=\"invalid_token\", error_description=\"OpenWork Connect debug token expired\"",
      }),
    }
  }
  if (input.scenario.fault === "forbidden") {
    return { kind: "response", label: "forbidden", response: jsonError(403, "forbidden", "The debug scenario denied this MCP resource.") }
  }
  if (input.scenario.fault === "down") {
    return { kind: "response", label: "down", response: jsonError(502, "upstream_unavailable", "The debug scenario interrupted the MCP upstream.") }
  }
  if (input.scenario.fault === "corrupt") {
    return {
      kind: "response",
      label: "corrupt",
      response: new Response("{this is not valid JSON", {
        headers: { "cache-control": "no-store", "content-type": "application/json" },
        status: 200,
      }),
    }
  }
  if (input.scenario.fault === "slow") return { kind: "delay", label: "slow", milliseconds: input.slowMs }
  if (input.scenario.fault === "hang") return { kind: "hang", label: "hang" }
  if (input.scenario.fault === "flaky") {
    const flaky = flakyRequestShouldFail(input.flakyKey, input.scenario.flakyFailures, input.flakyWindowMs, input.now)
    if (!flaky.fail) return null
    return {
      kind: "response",
      label: `${input.scenario.slug} request ${flaky.count}/${input.scenario.flakyFailures}`,
      response: jsonError(502, "flaky_upstream_failure", "The debug scenario failed this MCP request within its rolling window."),
    }
  }
  if (input.scenario.fault === "missing-tools" && input.requestBody) {
    return { kind: "tamper", label: "missing-tools", mode: "missing-tools" }
  }
  if (input.scenario.fault === "bad-protocol" && input.requestBody) {
    return { kind: "tamper", label: "bad-protocol", mode: "bad-protocol" }
  }
  return null
}

export function clearConnectDebugProxyFlakyWindows(): void {
  flakyWindows.clear()
}
