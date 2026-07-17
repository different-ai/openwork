import { describe, expect, test } from "bun:test"
import {
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
    expect(document).toContain("You’ll be redirected to sign in shortly.")
    expect(document).toContain('role="status"')
    expect(document).toContain('aria-live="polite"')
    expect(document).toContain("prefers-reduced-motion: reduce")
  })
})
