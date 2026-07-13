import { describe, expect, test } from "bun:test"
import { safeMcpAuthorizationUrl } from "../app/(den)/dashboard/_components/mcp-authorization-url"

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
