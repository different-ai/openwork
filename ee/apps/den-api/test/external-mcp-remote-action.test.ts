import { ErrorCode, McpError, UrlElicitationRequiredError } from "@modelcontextprotocol/sdk/types.js"
import { expect, test } from "bun:test"
import {
  externalMcpConnectionActionRequired,
  safeConnectionActionUrl,
} from "../src/mcp/external-mcp-remote-action.js"

// The admin-registered MCP endpoint. Every relayed connect link must share its
// origin. Real gateways serve their connect endpoint on this same origin.
const CONNECTION_URL = "https://gateway.example.test/servers/salesforce/mcp"
const SAME_ORIGIN_CONNECT = "https://gateway.example.test/servers/salesforce/connect/start"

function wrap(cause: unknown): Error {
  // How the enterprise adapter presents a downstream failure: the original
  // provider error hangs off the cause chain of an OpenWork wrapper.
  return new Error("Enterprise MCP tool-execution failed.", { cause })
}

function urlElicitation(url: string, overrides: Record<string, unknown> = {}) {
  return { mode: "url", message: "Sign in to continue", elicitationId: "elicit-1", url, ...overrides }
}

// 1. Current gateway dialect: remote -32001 with structured data.connect_url.
test("normalizes the gateway connect_url dialect into one connect action", () => {
  const error = wrap(new McpError(-32001, "Authorization required", {
    connect_url: SAME_ORIGIN_CONNECT,
    provider: "salesforce",
  }))

  expect(externalMcpConnectionActionRequired(error, { connectionUrl: CONNECTION_URL })).toEqual({
    connect_url: SAME_ORIGIN_CONNECT,
    provider: "salesforce",
  })
})

test("flattens a Markdown gateway connect link to one plain URL", () => {
  const error = wrap(new McpError(-32001, "Authorization required", {
    connect_url: `[Connect Salesforce](${SAME_ORIGIN_CONNECT})`,
  }))

  expect(externalMcpConnectionActionRequired(error, { connectionUrl: CONNECTION_URL })).toEqual({
    connect_url: SAME_ORIGIN_CONNECT,
  })
})

test("recovers the gateway dialect from a flattened JSON-RPC error string", () => {
  const error = new Error(`MCP request failed: ${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    error: { code: -32001, message: "Authorization required", data: { connect_url: SAME_ORIGIN_CONNECT } },
  })}`)

  expect(externalMcpConnectionActionRequired(error, { connectionUrl: CONNECTION_URL })?.connect_url)
    .toBe(SAME_ORIGIN_CONNECT)
})

// 2. Code-independent: the SAME structured data under a different server-range
// code must normalize identically, proving detection is not tied to -32001.
test("recognizes the connect_url dialect independent of the numeric code", () => {
  const underOtherCode = wrap(new McpError(-32050, "Connect required", {
    connect_url: SAME_ORIGIN_CONNECT,
    provider: "salesforce",
  }))

  expect(externalMcpConnectionActionRequired(underOtherCode, { connectionUrl: CONNECTION_URL })).toEqual({
    connect_url: SAME_ORIGIN_CONNECT,
    provider: "salesforce",
  })
})

// 3. Standard MCP SDK 1.29 URL elicitation (-32042 / UrlElicitationRequiredError).
test("normalizes a standard URL elicitation into the same connect action", () => {
  const viaSdkType = wrap(new UrlElicitationRequiredError([urlElicitation(SAME_ORIGIN_CONNECT)]))
  const viaWireCode = wrap(new McpError(ErrorCode.UrlElicitationRequired, "URL elicitation required", {
    elicitations: [urlElicitation(SAME_ORIGIN_CONNECT)],
  }))

  expect(externalMcpConnectionActionRequired(viaSdkType, { connectionUrl: CONNECTION_URL }))
    .toEqual({ connect_url: SAME_ORIGIN_CONNECT })
  expect(externalMcpConnectionActionRequired(viaWireCode, { connectionUrl: CONNECTION_URL }))
    .toEqual({ connect_url: SAME_ORIGIN_CONNECT })
})

test("URL elicitation takes precedence over a co-present connect_url dialect", () => {
  // Standards-first: if a provider emits both, the standard elicitation wins.
  const elicitationUrl = "https://gateway.example.test/servers/salesforce/elicit/1"
  const error = new McpError(ErrorCode.UrlElicitationRequired, "URL elicitation required", {
    elicitations: [urlElicitation(elicitationUrl)],
    connect_url: SAME_ORIGIN_CONNECT,
  })

  expect(externalMcpConnectionActionRequired(error, { connectionUrl: CONNECTION_URL }))
    .toEqual({ connect_url: elicitationUrl })
})

test("chooses the first valid elicitation deterministically and drops provider payload fields", () => {
  const second = "https://gateway.example.test/servers/salesforce/connect/second"
  const error = new UrlElicitationRequiredError([
    urlElicitation("javascript:alert(1)"),
    urlElicitation(second, { note: "provider-authored, must not leak" }),
  ])

  const action = externalMcpConnectionActionRequired(error, { connectionUrl: CONNECTION_URL })
  expect(action).toEqual({ connect_url: second })
})

test("validates elicitation shape and skips malformed entries", () => {
  const error = new McpError(ErrorCode.UrlElicitationRequired, "URL elicitation required", {
    elicitations: [
      { mode: "form", message: "no url here" },
      { mode: "url" },
      urlElicitation(SAME_ORIGIN_CONNECT),
    ],
  })

  expect(externalMcpConnectionActionRequired(error, { connectionUrl: CONNECTION_URL }))
    .toEqual({ connect_url: SAME_ORIGIN_CONNECT })
})

// 6. Unsafe URLs are rejected by the single safety gate.
test("rejects unsafe, malformed, and credential-bearing links in both dialects", () => {
  for (const unsafe of [
    "javascript:alert(1)",
    "file:///etc/passwd",
    "data:text/html,<script>1</script>",
    "not a url",
    "https://user:pass@gateway.example.test/connect",
    "ftp://gateway.example.test/connect",
  ]) {
    expect(safeConnectionActionUrl(unsafe, CONNECTION_URL)).toBeNull()
    const connectUrlError = wrap(new McpError(-32001, "Authorization required", { connect_url: unsafe }))
    expect(externalMcpConnectionActionRequired(connectUrlError, { connectionUrl: CONNECTION_URL })).toBeNull()
    const elicitationError = new UrlElicitationRequiredError([urlElicitation(unsafe)])
    expect(externalMcpConnectionActionRequired(elicitationError, { connectionUrl: CONNECTION_URL })).toBeNull()
  }
})

test("accepts a safe same-origin http(s) link", () => {
  expect(safeConnectionActionUrl(SAME_ORIGIN_CONNECT, CONNECTION_URL)).toBe(SAME_ORIGIN_CONNECT)
})

// 7. Origin mismatch: a link whose host differs from the registered connection
// origin is not relayed, even if otherwise well-formed.
test("rejects a cross-origin link and produces no connect action", () => {
  const crossOrigin = "https://phish.example.test/servers/salesforce/connect/start"
  expect(safeConnectionActionUrl(crossOrigin, CONNECTION_URL)).toBeNull()

  const connectUrlError = wrap(new McpError(-32001, "Authorization required", { connect_url: crossOrigin }))
  const elicitationError = wrap(new UrlElicitationRequiredError([urlElicitation(crossOrigin)]))
  expect(externalMcpConnectionActionRequired(connectUrlError, { connectionUrl: CONNECTION_URL })).toBeNull()
  expect(externalMcpConnectionActionRequired(elicitationError, { connectionUrl: CONNECTION_URL })).toBeNull()
})

// 8. Message independence, both directions.
test("recognizes structured actions regardless of the provider message text", () => {
  const localized = wrap(new McpError(-32001, "Autorisation requise — connectez votre compte", {
    connect_url: SAME_ORIGIN_CONNECT,
  }))

  expect(externalMcpConnectionActionRequired(localized, { connectionUrl: CONNECTION_URL })?.connect_url)
    .toBe(SAME_ORIGIN_CONNECT)
})

test("free-text 'authorization required' without structured data creates no link action", () => {
  const textOnly = wrap(new McpError(-32001, "Authorization required to use this connector.", undefined))
  const flattened = new Error("Streamable HTTP error: authorization required, please sign in")

  expect(externalMcpConnectionActionRequired(textOnly, { connectionUrl: CONNECTION_URL })).toBeNull()
  expect(externalMcpConnectionActionRequired(flattened, { connectionUrl: CONNECTION_URL })).toBeNull()
})

test("drops an untrusted provider label that fails strict validation", () => {
  const error = wrap(new McpError(-32001, "Authorization required", {
    connect_url: SAME_ORIGIN_CONNECT,
    provider: "sales force <script>",
  }))

  expect(externalMcpConnectionActionRequired(error, { connectionUrl: CONNECTION_URL })).toEqual({
    connect_url: SAME_ORIGIN_CONNECT,
  })
})

test("returns null when the connection URL itself is unusable for origin binding", () => {
  const error = new McpError(-32001, "Authorization required", { connect_url: SAME_ORIGIN_CONNECT })
  expect(externalMcpConnectionActionRequired(error, { connectionUrl: "not-a-url" })).toBeNull()
})
