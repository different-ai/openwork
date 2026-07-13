import { describe, expect, test } from "bun:test"
import { assertPublicUrl, createGuardedFetch, createRealmSafeFetch, isPrivateAddress, PrivateUrlError } from "../src/capability-sources/url-guard.js"

describe("isPrivateAddress", () => {
  test.each([
    ["127.0.0.1", true],
    ["127.255.255.255", true],
    ["10.0.0.1", true],
    ["10.255.255.255", true],
    ["172.16.0.1", true],
    ["172.31.255.255", true],
    ["192.168.1.1", true],
    ["169.254.169.254", true], // cloud metadata
    ["169.254.0.1", true],
    ["100.64.0.1", true], // CGNAT
    ["100.127.255.255", true],
    ["0.0.0.0", true],
    ["198.18.0.1", true],
    ["224.0.0.1", true], // multicast
    ["255.255.255.255", true], // broadcast
    ["::1", true],
    ["::", true],
    ["fc00::1", true],
    ["fd12:3456::1", true],
    ["fe80::1", true],
    ["::ffff:127.0.0.1", true], // mapped loopback
    ["::ffff:10.0.0.1", true], // mapped private
    ["::ffff:7f00:1", true], // canonical mapped loopback
    ["::ffff:a9fe:a9fe", true], // canonical mapped cloud metadata/link-local
    ["::7f00:1", true], // deprecated IPv4-compatible loopback
    ["64:ff9b::7f00:1", true], // NAT64-encoded loopback
    ["ff02::1", true], // multicast
    ["fec0::1", true], // deprecated site-local
    ["2001:db8::1", true], // documentation/reserved
    ["not-an-ip", true], // fail closed
  ])("blocks %s", (address, expected) => {
    expect(isPrivateAddress(address)).toBe(expected)
  })

  test.each([
    ["1.1.1.1", false],
    ["8.8.8.8", false],
    ["104.18.0.1", false],
    ["172.15.255.255", false], // just outside 172.16/12
    ["172.32.0.1", false],
    ["100.63.255.255", false], // just outside CGNAT
    ["100.128.0.1", false],
    ["169.253.1.1", false],
    ["198.17.0.1", false],
    ["2606:4700:4700::1111", false],
    ["::ffff:8.8.8.8", false], // mapped public
    ["::ffff:808:808", false], // canonical mapped public
  ])("allows %s", (address, expected) => {
    expect(isPrivateAddress(address)).toBe(expected)
  })
})

describe("createGuardedFetch", () => {
  test("blocks a public endpoint redirecting to loopback before the second request", async () => {
    const requested: string[] = []
    const guardedFetch = createGuardedFetch(async (url) => {
      requested.push(String(url))
      return new Response(null, { status: 302, headers: { location: "http://127.0.0.1:8080/private" } })
    })

    await expect(guardedFetch("https://1.1.1.1/start")).rejects.toBeInstanceOf(PrivateUrlError)
    expect(requested).toEqual(["https://1.1.1.1/start"])
  })

  test("follows a bounded public redirect and strips cross-origin credentials", async () => {
    const requests: Array<{
      url: string
      authorization: string | null
      sessionId: string | null
      lastEventId: string | null
    }> = []
    const guardedFetch = createGuardedFetch(async (url, init) => {
      const headers = new Headers(init?.headers)
      requests.push({
        url: String(url),
        authorization: headers.get("authorization"),
        sessionId: headers.get("mcp-session-id"),
        lastEventId: headers.get("last-event-id"),
      })
      if (requests.length === 1) {
        return new Response(null, { status: 307, headers: { location: "https://8.8.8.8/mcp" } })
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
    })

    const response = await guardedFetch("https://1.1.1.1/start", {
      headers: {
        authorization: "Bearer must-not-forward",
        "mcp-session-id": "session-must-not-forward",
        "last-event-id": "resume-must-not-forward",
      },
    })
    expect(response.status).toBe(200)
    expect(requests).toEqual([
      {
        url: "https://1.1.1.1/start",
        authorization: "Bearer must-not-forward",
        sessionId: "session-must-not-forward",
        lastEventId: "resume-must-not-forward",
      },
      { url: "https://8.8.8.8/mcp", authorization: null, sessionId: null, lastEventId: null },
    ])
  })

  test("blocks cross-origin 307 redirects before forwarding OAuth or tool request bodies", async () => {
    const requested: string[] = []
    const guardedFetch = createGuardedFetch(async (url) => {
      requested.push(String(url))
      return new Response(null, { status: 307, headers: { location: "https://8.8.8.8/token" } })
    })

    await expect(guardedFetch("https://1.1.1.1/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code: "must-not-forward", code_verifier: "must-not-forward" }),
    })).rejects.toBeInstanceOf(PrivateUrlError)
    expect(requested).toEqual(["https://1.1.1.1/token"])
  })

  test("blocks HTTPS redirects to cleartext endpoints", async () => {
    const requested: string[] = []
    const guardedFetch = createGuardedFetch(async (url) => {
      requested.push(String(url))
      return new Response(null, { status: 302, headers: { location: "http://8.8.8.8/mcp" } })
    })

    await expect(guardedFetch("https://1.1.1.1/mcp")).rejects.toBeInstanceOf(PrivateUrlError)
    expect(requested).toEqual(["https://1.1.1.1/mcp"])
  })
})

describe("assertPublicUrl", () => {
  test("rejects private IP literals", async () => {
    await expect(assertPublicUrl("http://127.0.0.1:3978/mcp")).rejects.toBeInstanceOf(PrivateUrlError)
    await expect(assertPublicUrl("http://169.254.169.254/latest/meta-data/")).rejects.toBeInstanceOf(PrivateUrlError)
    await expect(assertPublicUrl("http://10.0.0.5/mcp")).rejects.toBeInstanceOf(PrivateUrlError)
    await expect(assertPublicUrl("http://[::1]:8080/mcp")).rejects.toBeInstanceOf(PrivateUrlError)
    await expect(assertPublicUrl("https://[::ffff:7f00:1]/mcp")).rejects.toBeInstanceOf(PrivateUrlError)
    await expect(assertPublicUrl("https://[::ffff:a9fe:a9fe]/latest/meta-data")).rejects.toBeInstanceOf(PrivateUrlError)
  })

  test("rejects hostnames that resolve to loopback (the DNS-rebinding case)", async () => {
    // "localhost" is the universally-resolvable stand-in for a public-looking
    // hostname whose DNS answer is a private address.
    await expect(assertPublicUrl("http://localhost:3978/mcp")).rejects.toBeInstanceOf(PrivateUrlError)
  })

  test("rejects non-http(s) protocols and garbage", async () => {
    await expect(assertPublicUrl("file:///etc/passwd")).rejects.toBeInstanceOf(PrivateUrlError)
    await expect(assertPublicUrl("gopher://example.com/")).rejects.toBeInstanceOf(PrivateUrlError)
    await expect(assertPublicUrl("not a url")).rejects.toBeInstanceOf(PrivateUrlError)
    await expect(assertPublicUrl("https://user:password@1.1.1.1/mcp")).rejects.toBeInstanceOf(PrivateUrlError)
  })

  test("allows public IP literals without any DNS lookup", async () => {
    await expect(assertPublicUrl("https://1.1.1.1/mcp")).resolves.toBeUndefined()
  })

  test("requires HTTPS for hosted public endpoints", async () => {
    await expect(assertPublicUrl("http://1.1.1.1/mcp")).rejects.toBeInstanceOf(PrivateUrlError)
  })
})

describe("createRealmSafeFetch", () => {
  test("allows private HTTP endpoints without forwarding bodies across origins", async () => {
    const requested: string[] = []
    const realmSafeFetch = createRealmSafeFetch(async (url) => {
      requested.push(String(url))
      return new Response(null, { status: 307, headers: { location: "http://127.0.0.2/token" } })
    })

    await expect(realmSafeFetch("http://127.0.0.1/token", {
      method: "POST",
      body: new URLSearchParams({ code: "private-mode-secret" }),
    })).rejects.toBeInstanceOf(PrivateUrlError)
    expect(requested).toEqual(["http://127.0.0.1/token"])
  })

  test("strips MCP session and resume credentials on private-mode cross-origin GET redirects", async () => {
    const requests: Array<{ url: string; sessionId: string | null; lastEventId: string | null }> = []
    const realmSafeFetch = createRealmSafeFetch(async (url, init) => {
      const headers = new Headers(init?.headers)
      requests.push({
        url: String(url),
        sessionId: headers.get("mcp-session-id"),
        lastEventId: headers.get("last-event-id"),
      })
      return requests.length === 1
        ? new Response(null, { status: 302, headers: { location: "http://127.0.0.2/events" } })
        : new Response(null, { status: 204 })
    })

    await expect(realmSafeFetch("http://127.0.0.1/events", {
      headers: { "mcp-session-id": "session-secret", "last-event-id": "resume-secret" },
    })).resolves.toHaveProperty("status", 204)
    expect(requests).toEqual([
      { url: "http://127.0.0.1/events", sessionId: "session-secret", lastEventId: "resume-secret" },
      { url: "http://127.0.0.2/events", sessionId: null, lastEventId: null },
    ])
  })
})
