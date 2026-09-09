import { describe, expect, test } from "bun:test"
import {
  describeMcpAuthorizationFailure,
  mcpAuthorizationTabUrl,
  parseMcpAuthorizationTabState,
  safeMcpAuthorizationUrl,
} from "../app/(den)/dashboard/_components/mcp-authorization-url"

describe("safeMcpAuthorizationUrl", () => {
  test("allows provider HTTPS and loopback HTTP authorization URLs", () => {
    expect(safeMcpAuthorizationUrl("https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize?state=opaque"))
      .toStartWith("https://login.microsoftonline.com/")
    expect(safeMcpAuthorizationUrl("http://127.0.0.1:3978/authorize")).toBe("http://127.0.0.1:3978/authorize")
    expect(safeMcpAuthorizationUrl("http://localhost:3978/authorize")).toBe("http://localhost:3978/authorize")
  })

  test.each([
    "http://login.example.com/authorize",
    "https://user:password@login.example.com/authorize",
    "javascript:alert(1)",
    "data:text/html,unsafe",
    "file:///tmp/token",
    "not a url",
  ])(
    "rejects unsafe provider authorization URL %s",
    (url) => expect(() => safeMcpAuthorizationUrl(url)).toThrow(),
  )
})

describe("MCP authorization tab state", () => {
  test("round-trips a failed connection through readable tab parameters", () => {
    const failure = {
      message: "The provider rejected this redirect URI.",
      details: {
        httpStatus: 424,
        errorCode: "mcp_oauth_start_failed",
        diagnosticCode: "MCP_OAUTH_REDIRECT_URI_NOT_ALLOWED",
        diagnosticReference: "diag_example",
        redirectUri: "https://api.example.test/v1/mcp-connections/oauth/callback",
        retryable: false,
        actionOwner: "provider_admin",
        responseJson: "{}",
      },
    }
    const url = new URL(mcpAuthorizationTabUrl({
      connectionId: "connection_example",
      connectionName: "Example calendar",
      failure,
    }), "https://app.example.test")

    expect(url.pathname).toBe("/connect/oauth")
    expect(url.searchParams.get("connection")).toBe("connection_example")
    expect(url.searchParams.get("name")).toBe("Example calendar")
    expect(url.searchParams.get("outcome")).toBe("failed")
    expect(parseMcpAuthorizationTabState(url.searchParams)).toEqual({
      connectionId: "connection_example",
      connectionName: "Example calendar",
      outcome: "failed",
      failure,
    })
  })
})

describe("describeMcpAuthorizationFailure", () => {
  test("explains a provider redirect allowlist failure without retry advice", () => {
    const description = describeMcpAuthorizationFailure({
      connectionName: "Example calendar",
      message: "The provider rejected OpenWork's OAuth callback.",
      details: {
        httpStatus: 424,
        diagnosticCode: "MCP_OAUTH_REDIRECT_URI_NOT_ALLOWED",
        diagnosticReference: "diag_example",
        redirectUri: "https://api.example.test/v1/mcp-connections/oauth/callback",
        retryable: false,
        actionOwner: "provider_admin",
        responseJson: "{}",
      },
    })

    expect(description.title).toBe("Example calendar hasn't approved OpenWork yet")
    expect(description.description).toContain("Retrying won't help")
    expect(description.advice.join(" ")).toContain("https://api.example.test/v1/mcp-connections/oauth/callback")
    expect(description.copyable).toEqual([
      { label: "Redirect URI", value: "https://api.example.test/v1/mcp-connections/oauth/callback" },
      { label: "Reference", value: "diag_example" },
    ])
    expect(description.retryable).toBe(false)
    expect(description.advice.join(" ")).not.toMatch(/try again/i)
  })

  test("keeps the plain-language unreadable-response message", () => {
    const message = "OpenWork could not read the answer from its API when starting the sign-in. The browser blocked the response or the request never completed. Try again; if it keeps happening, tell your workspace admin the time of this attempt."
    const description = describeMcpAuthorizationFailure({
      connectionName: "Example calendar",
      message,
      details: {
        httpStatus: "unavailable",
        errorCode: "response_unreadable",
        responseJson: "{}",
      },
    })

    expect(description.title).toBe("OpenWork couldn't read its own API's answer")
    expect(description.description).toBe(message)
    expect(description.advice.join(" ")).toMatch(/Try again/)
  })

  test("allows retry advice for a generic retryable failure", () => {
    const description = describeMcpAuthorizationFailure({
      connectionName: "Example calendar",
      message: "The sign-in service was temporarily unavailable.",
      details: { httpStatus: 424, retryable: true, responseJson: "{}" },
    })

    expect(description.retryable).toBe(true)
    expect(description.advice).toContain("Try again.")
  })

  test("does not suggest retrying a non-retryable provider-admin failure", () => {
    const description = describeMcpAuthorizationFailure({
      connectionName: "Example calendar",
      message: "The provider must update its configuration.",
      details: {
        httpStatus: 424,
        retryable: false,
        actionOwner: "provider_admin",
        diagnosticReference: "diag_example",
        responseJson: "{}",
      },
    })

    expect(description.retryable).toBe(false)
    expect(description.advice.join(" ")).toContain("Example calendar has to fix this on their side")
    expect(description.advice.join(" ")).not.toMatch(/try again/i)
  })
})
