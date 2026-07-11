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

describe("redirect-safe MCP fetch", () => {
  test("blocks a public redirect to loopback or metadata before the pivot request", async () => {
    for (const location of ["http://127.0.0.1:8080/private", "http://169.254.169.254/latest/meta-data/"]) {
      const requested: string[] = []
      const guardedFetch = createGuardedFetch(async (url) => {
        requested.push(String(url))
        return new Response(null, { status: 302, headers: { location } })
      })
      await expect(guardedFetch("https://1.1.1.1/start")).rejects.toBeInstanceOf(PrivateUrlError)
      expect(requested).toEqual(["https://1.1.1.1/start"])
    }
  })

  test("cancels rejected redirect bodies exactly once for private, credential-bearing, and malformed targets", async () => {
    for (const location of [
      "http://127.0.0.1:8080/private",
      "https://user:password@8.8.8.8/mcp",
      "http://[",
    ]) {
      let activeBodies = 0
      let cancellations = 0
      const requested: string[] = []
      const guardedFetch = createGuardedFetch(async (url) => {
        requested.push(String(url))
        const body = new ReadableStream({
          start() {
            activeBodies += 1
          },
          cancel() {
            cancellations += 1
            activeBodies -= 1
          },
        })
        return new Response(body, { status: 302, headers: { location } })
      })

      await expect(guardedFetch("https://1.1.1.1/start")).rejects.toThrow()
      expect(requested).toEqual(["https://1.1.1.1/start"])
      expect(cancellations).toBe(1)
      expect(activeBodies).toBe(0)
    }
  })

  test("strips token, API-key, session, and resume headers on a cross-origin GET redirect", async () => {
    const observed: string[][] = []
    const guardedFetch = createGuardedFetch(async (_url, init) => {
      observed.push([...new Headers(init?.headers).keys()].sort())
      return observed.length === 1
        ? new Response(null, { status: 302, headers: { location: "https://8.8.8.8/events" } })
        : new Response(null, { status: 204 })
    })
    await guardedFetch("https://1.1.1.1/events", {
      headers: {
        accept: "text/event-stream",
        authorization: "Bearer secret",
        cookie: "session=secret",
        "proxy-authorization": "Basic secret",
        "mcp-session-id": "session-secret",
        "last-event-id": "resume-secret",
        "mcp-resume-token": "resume-token-secret",
        "x-api-key": "api-key-secret",
        "api-key": "api-key-secret",
        "x-auth-token": "auth-token-secret",
      },
    })
    expect(observed).toEqual([
      ["accept", "api-key", "authorization", "cookie", "last-event-id", "mcp-resume-token", "mcp-session-id", "proxy-authorization", "x-api-key", "x-auth-token"],
      ["accept"],
    ])
  })

  test.each([307, 308])("blocks cross-origin %i replay of OAuth or MCP POST bodies", async (status) => {
    const requested: string[] = []
    const guardedFetch = createGuardedFetch(async (url) => {
      requested.push(String(url))
      return new Response(null, { status, headers: { location: "https://8.8.8.8/token" } })
    })
    await expect(guardedFetch("https://1.1.1.1/token", {
      method: "POST",
      headers: { authorization: "Bearer secret", "x-api-key": "api-key-secret" },
      body: new URLSearchParams({ code: "secret", code_verifier: "secret" }),
    })).rejects.toBeInstanceOf(PrivateUrlError)
    expect(requested).toEqual(["https://1.1.1.1/token"])
  })

  test("blocks HTTPS downgrade and enforces the redirect hop ceiling", async () => {
    const downgradeFetch = createGuardedFetch(async () => new Response(null, {
      status: 302,
      headers: { location: "http://8.8.8.8/mcp" },
    }))
    await expect(downgradeFetch("https://1.1.1.1/mcp")).rejects.toBeInstanceOf(PrivateUrlError)

    let hops = 0
    const loopingFetch = createGuardedFetch(async () => {
      hops += 1
      return new Response(null, { status: 302, headers: { location: "/again" } })
    })
    await expect(loopingFetch("https://1.1.1.1/start")).rejects.toThrow("redirect limit")
    expect(hops).toBe(6)
  })

  test("private mode still blocks cross-origin body replay and strips session credentials", async () => {
    const requests: Array<{ url: string; headers: string[] }> = []
    const fetch = createRealmSafeFetch(async (url, init) => {
      requests.push({ url: String(url), headers: [...new Headers(init?.headers).keys()].sort() })
      return requests.length === 1
        ? new Response(null, { status: 302, headers: { location: "http://127.0.0.2/events" } })
        : new Response(null, { status: 204 })
    })
    await fetch("http://127.0.0.1/events", {
      headers: { accept: "text/event-stream", "mcp-session-id": "secret", "last-event-id": "secret" },
    })
    expect(requests).toEqual([
      { url: "http://127.0.0.1/events", headers: ["accept", "last-event-id", "mcp-session-id"] },
      { url: "http://127.0.0.2/events", headers: ["accept"] },
    ])
    requests.length = 0
    await expect(fetch("http://127.0.0.1/token", {
      method: "POST",
      body: "secret",
    })).rejects.toBeInstanceOf(PrivateUrlError)
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
