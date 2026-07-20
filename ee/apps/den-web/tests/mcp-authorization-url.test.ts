import { describe, expect, test } from "bun:test"
import {
  mcpAuthorizationErrorDocument,
  mcpAuthorizationPendingDocument,
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

describe("mcpAuthorizationPendingDocument", () => {
  test("renders a concise accessible connection screen before provider redirect", () => {
    const document = mcpAuthorizationPendingDocument()

    expect(document).toContain("Preparing your connection")
    expect(document).toContain("securely checking the provider")
    expect(document).toContain("Keep this window open")
    expect(document).toContain("OpenWork Connect")
    expect(document).toContain('role="status"')
    expect(document).toContain('aria-live="polite"')
    expect(document).toContain("prefers-reduced-motion: reduce")
  })
})

describe("mcpAuthorizationErrorDocument", () => {
  test("keeps OAuth failures visible with the exact redirect URI", () => {
    const document = mcpAuthorizationErrorDocument({
      message: "A pre-registered OAuth client is required.",
      details: {
        httpStatus: 409,
        errorCode: "mcp_oauth_configuration_required",
        redirectUri: "https://api.openwork.example/v1/mcp-connections/oauth/callback",
        clientMetadataUrl: "https://api.openwork.example/.well-known/oauth-client",
        responseJson: JSON.stringify({
          error: "mcp_oauth_configuration_required",
          callbackUrl: "https://api.openwork.example/v1/mcp-connections/oauth/callback",
        }, null, 2),
      },
    })

    expect(document).toContain("Connection failed")
    expect(document).toContain("A pre-registered OAuth client is required.")
    expect(document).toContain("Technical details")
    expect(document).toContain("Redirect URI")
    expect(document).toContain("https://api.openwork.example/v1/mcp-connections/oauth/callback")
    expect(document).toContain("HTTP status")
    expect(document).toContain("409")
    expect(document).toContain("Error code")
    expect(document).toContain("mcp_oauth_configuration_required")
    expect(document).toContain("Response payload")
    expect(document).toContain("<details>")
    expect(document).not.toContain("<details open")
    expect(document).toContain('role="alert"')
    expect(document).not.toContain("window.close")
  })

  test("escapes API error details before writing them into the popup", () => {
    const document = mcpAuthorizationErrorDocument({
      message: '<script>alert("message")</script>',
      details: {
        httpStatus: 502,
        redirectUri: 'https://example.com/callback?next=<script>alert("uri")</script>',
        responseJson: '<script>alert("response")</script>',
      },
    })

    expect(document).not.toContain("<script>alert")
    expect(document).toContain("&lt;script&gt;alert(&quot;message&quot;)&lt;/script&gt;")
    expect(document).toContain("next=&lt;script&gt;alert(&quot;uri&quot;)&lt;/script&gt;")
    expect(document).toContain("&lt;script&gt;alert(&quot;response&quot;)&lt;/script&gt;")
  })
})
