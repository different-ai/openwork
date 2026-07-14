import { describe, expect, test } from "bun:test"
import {
  closeMcpAuthorizationWindow,
  mcpAuthorizationWindowName,
  navigateMcpAuthorizationWindow,
  openMcpAuthorizationWindow,
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

  test("pre-opens a named same-origin blank popup without preserving an opener", () => {
    let opened: { features: string; target: string; url: string } | null = null
    let closed = false
    const authorizationWindow = {
      get closed() {
        return closed
      },
      close() {
        closed = true
      },
      location: { replace() {} },
      opener: {},
    }

    const result = openMcpAuthorizationWindow("External MCP / Issues", (url, target, features) => {
      opened = { features, target, url }
      return authorizationWindow
    })

    expect(opened).toEqual({
      features: "popup=yes,width=640,height=760",
      target: "openwork-mcp-oauth-external-mcp-issues",
      url: "about:blank",
    })
    expect(mcpAuthorizationWindowName("!!!")).toBe("openwork-mcp-oauth-connection")
    expect(result).toBe(authorizationWindow)
    expect(result?.opener).toBeNull()
  })

  test("detects a blocked popup and validates before navigating a live popup", () => {
    expect(openMcpAuthorizationWindow("issues", () => null)).toBeNull()

    let destination: string | null = null
    const authorizationWindow = {
      closed: false,
      close() {},
      location: {
        replace(url: string) {
          destination = url
        },
      },
      opener: null,
    }
    expect(navigateMcpAuthorizationWindow(
      authorizationWindow,
      "https://login.example.com/authorize?state=opaque",
    )).toEqual({
      authorizeUrl: "https://login.example.com/authorize?state=opaque",
      navigated: true,
    })
    expect(destination).toBe("https://login.example.com/authorize?state=opaque")

    destination = null
    expect(() => navigateMcpAuthorizationWindow(authorizationWindow, "javascript:alert(1)")).toThrow()
    expect(destination).toBeNull()
  })

  test("does not navigate a closed popup and closes a live popup safely", () => {
    let closeCount = 0
    const closedWindow = {
      closed: true,
      close() {
        closeCount += 1
      },
      location: {
        replace() {
          throw new Error("closed popup must not be navigated")
        },
      },
      opener: null,
    }
    expect(navigateMcpAuthorizationWindow(
      closedWindow,
      "https://login.example.com/authorize",
    )).toEqual({
      authorizeUrl: "https://login.example.com/authorize",
      navigated: false,
    })
    closeMcpAuthorizationWindow(closedWindow)
    expect(closeCount).toBe(0)

    const liveWindow = { ...closedWindow, closed: false }
    closeMcpAuthorizationWindow(liveWindow)
    expect(closeCount).toBe(1)
  })
})
