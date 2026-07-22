export type ConnectDebugProxyFault =
  | "auth-expired"
  | "bad-protocol"
  | "corrupt"
  | "den-outage"
  | "down"
  | "forbidden"
  | "hang"
  | "missing-tools"
  | "slow"
  | "token-mint-fail"

export type ConnectDebugProxyScenario = {
  fault: ConnectDebugProxyFault | "default" | "flaky"
  flakyFailures: number
  slug: string
}

export type ConnectDebugProxyScenarioRow = {
  breaks: string
  expected: string
  slug: string
}

export const CONNECT_DEBUG_PROXY_SCENARIOS: readonly ConnectDebugProxyScenarioRow[] = [
  { slug: "default", breaks: "Nothing; pure pass-through.", expected: "Agent access Ready; no firstFailure; initialize and tools/list succeed." },
  { slug: "auth-expired", breaks: "Agent MCP requests return HTTP 401.", expected: "engine_needs_auth / invalid_mcp_token; probe initialize shows HTTP 401." },
  { slug: "forbidden", breaks: "Agent MCP requests return HTTP 403.", expected: "engine_needs_auth / wrong_mcp_resource; probe initialize shows HTTP 403." },
  { slug: "down", breaks: "Agent MCP requests return HTTP 502.", expected: "Engine failed; usually opencode_mcp_sync_failed with fetch/upstream failure detail; probe initialize shows HTTP 502." },
  { slug: "den-outage", breaks: "Every proxied Den request returns HTTP 503.", expected: "Sign-in and token mint fail; no usable Agent access state can be established." },
  { slug: "slow", breaks: "Agent MCP requests wait 5–10 seconds before forwarding.", expected: "Slow probe steps; client timeout behavior depends on its configured deadline." },
  { slug: "hang", breaks: "Agent MCP requests never answer before the caller or function times out.", expected: "Engine failed with fetch/timeout detail; direct probe records a transport timeout." },
  { slug: "flaky-3", breaks: "The first three Agent MCP requests per instance/window return HTTP 502.", expected: "Transient engine/probe failure, followed by recovery after retries exceed the failure count." },
  { slug: "missing-tools", breaks: "tools/list omits execute_capability in JSON and SSE responses.", expected: "cloud_tools_missing / cloud_tools_missing; probe tools_list succeeds but reports the missing tool." },
  { slug: "bad-protocol", breaks: "initialize reports unsupported protocol version 1900-01-01.", expected: "Engine protocol failure; probe initialize trace exposes the unsupported protocol value." },
  { slug: "corrupt", breaks: "Agent MCP requests return invalid JSON.", expected: "Engine protocol/parse failure; direct probe cannot parse initialize or tools/list." },
  { slug: "token-mint-fail", breaks: "Only /v1/mcp/token returns HTTP 503.", expected: "Sign-in remains usable; Repair and test reports cloud_mcp_token_mint_failed before engine delivery." },
]

export function parseConnectDebugProxyScenario(value: string): ConnectDebugProxyScenario | null {
  if (value === "default") return { fault: "default", flakyFailures: 0, slug: value }
  if (value === "auth-expired" || value === "bad-protocol" || value === "corrupt"
    || value === "den-outage" || value === "down" || value === "forbidden"
    || value === "hang" || value === "missing-tools" || value === "slow"
    || value === "token-mint-fail") {
    return { fault: value, flakyFailures: 0, slug: value }
  }
  const match = /^flaky-([1-9]|[1-4][0-9]|50)$/u.exec(value)
  if (!match) return null
  return { fault: "flaky", flakyFailures: Number.parseInt(match[1] ?? "0", 10), slug: value }
}

export function isAgentEndpoint(pathname: string): boolean {
  return pathname === "/mcp/agent" || pathname === "/api/den/mcp/agent"
}

export function isTokenMintEndpoint(pathname: string): boolean {
  return pathname === "/v1/mcp/token" || pathname === "/api/den/v1/mcp/token"
}
