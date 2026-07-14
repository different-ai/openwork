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
    ["192.0.0.1", true], // IETF protocol assignments
    ["192.0.0.255", true],
    ["192.0.2.1", true], // TEST-NET-1
    ["192.0.2.255", true],
    ["192.88.99.1", true], // deprecated 6to4 relay anycast
    ["198.18.0.1", true],
    ["198.51.100.1", true], // TEST-NET-2
    ["198.51.100.255", true],
    ["203.0.113.1", true], // TEST-NET-3
    ["203.0.113.255", true],
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
    ["64:ff9b:1::", true], // RFC 8215 local-use NAT64 /48 first address
    ["64:ff9b:1::808:808", true], // RFC 8215 local-use NAT64 prefix
    ["64:ff9b:1:ffff:ffff:ffff:ffff:ffff", true], // RFC 8215 local-use NAT64 /48 last address
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
    ["192.0.1.1", false],
    ["192.88.98.1", false],
    ["198.51.99.1", false],
    ["203.0.112.1", false],
    ["2606:4700:4700::1111", false],
    ["::ffff:8.8.8.8", false], // mapped public
    ["::ffff:808:808", false], // canonical mapped public
    ["64:ff9b::808:808", false], // well-known NAT64 prefix with a public target
    ["64:ff9b:2::808:808", false], // outside the RFC 8215 local-use /48
  ])("allows %s", (address, expected) => {
    expect(isPrivateAddress(address)).toBe(expected)
  })
})

describe("createGuardedFetch", () => {
  test("pins the checked DNS address into the outbound request instead of resolving twice", async () => {
    let resolutionCount = 0
    const pinnedAddresses: string[] = []
    const guardedFetch = createGuardedFetch(undefined, {
      resolveHostname: async (hostname) => {
        expect(hostname).toBe("rebind.example")
        resolutionCount += 1
        return [{ address: resolutionCount === 1 ? "1.1.1.1" : "127.0.0.1" }]
      },
      fetchPinned: async (_url, _init, target) => {
        pinnedAddresses.push(target.address)
        return new Response("ok", { status: 200 })
      },
    })

    await expect(guardedFetch("https://rebind.example/mcp")).resolves.toHaveProperty("status", 200)
    expect(resolutionCount).toBe(1)
    expect(pinnedAddresses).toEqual(["1.1.1.1"])
  })

  test("tries another validated DNS answer for an idempotent request", async () => {
    const pinnedAddresses: string[] = []
    const guardedFetch = createGuardedFetch(undefined, {
      resolveHostname: async () => [{ address: "2606:4700:4700::1111" }, { address: "1.1.1.1" }],
      fetchPinned: async (_url, _init, target) => {
        pinnedAddresses.push(target.address)
        if (target.family === 6) throw new Error("IPv6 route unavailable")
        return new Response("ok", { status: 200 })
      },
    })

    await expect(guardedFetch("https://dual-stack.example/mcp")).resolves.toHaveProperty("status", 200)
    expect(pinnedAddresses).toEqual(["2606:4700:4700::1111", "1.1.1.1"])
  })

  test("does not replay a non-idempotent body across validated DNS answers", async () => {
    const pinnedAddresses: string[] = []
    const guardedFetch = createGuardedFetch(undefined, {
      resolveHostname: async () => [{ address: "1.1.1.1" }, { address: "8.8.8.8" }],
      fetchPinned: async (_url, _init, target) => {
        pinnedAddresses.push(target.address)
        throw new Error("socket closed")
      },
    })

    await expect(guardedFetch("https://dual-stack.example/token", {
      body: new URLSearchParams({ code: "one-time-code" }),
      method: "POST",
    })).rejects.toThrow("socket closed")
    expect(pinnedAddresses).toEqual(["1.1.1.1"])
  })

  test("applies the caller deadline while DNS resolution is pending", async () => {
    const guardedFetch = createGuardedFetch(undefined, {
      resolveHostname: async () => new Promise(() => {}),
      fetchPinned: async () => new Response("unexpected"),
    })

    await expect(guardedFetch("https://slow-dns.example/mcp", {
      signal: AbortSignal.timeout(10),
    })).rejects.toThrow()
  })

  test("re-checks every redirect hop and blocks a hostname that rebinds before it is followed", async () => {
    let resolutionCount = 0
    const requested: Array<{ url: string; address: string }> = []
    const guardedFetch = createGuardedFetch(undefined, {
      resolveHostname: async () => {
        resolutionCount += 1
        return [{ address: resolutionCount === 1 ? "1.1.1.1" : "169.254.169.254" }]
      },
      fetchPinned: async (url, _init, target) => {
        requested.push({ url: url.toString(), address: target.address })
        return new Response(null, { status: 302, headers: { location: "/private" } })
      },
    })

    await expect(guardedFetch("https://rebind.example/start")).rejects.toBeInstanceOf(PrivateUrlError)
    expect(resolutionCount).toBe(2)
    expect(requested).toEqual([{ url: "https://rebind.example/start", address: "1.1.1.1" }])
  })

  test("uses a separately checked address for each public redirect origin", async () => {
    const requested: Array<{ url: string; address: string }> = []
    const guardedFetch = createGuardedFetch(undefined, {
      resolveHostname: async (hostname) => [{
        address: hostname === "one.example" ? "1.1.1.1" : "8.8.8.8",
      }],
      fetchPinned: async (url, _init, target) => {
        requested.push({ url: url.toString(), address: target.address })
        return requested.length === 1
          ? new Response(null, { status: 302, headers: { location: "https://two.example/mcp" } })
          : new Response("ok", { status: 200 })
      },
    })

    await expect(guardedFetch("https://one.example/start")).resolves.toHaveProperty("status", 200)
    expect(requested).toEqual([
      { url: "https://one.example/start", address: "1.1.1.1" },
      { url: "https://two.example/mcp", address: "8.8.8.8" },
    ])
  })

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
  test("redacts the raw URL from preflight errors", async () => {
    const rawUrl = "https://127.0.0.1/mcp?publisherSpecificValue=must-not-reflect"
    let caught: unknown
    try {
      await assertPublicUrl(rawUrl)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(PrivateUrlError)
    expect(caught).toBeInstanceOf(Error)
    if (!(caught instanceof Error)) throw new Error("Expected URL preflight to fail.")
    expect(caught.message).not.toContain(rawUrl)
    expect(caught.message).not.toContain("must-not-reflect")
  })

  test("honors a caller lifecycle deadline before DNS work starts", async () => {
    const reason = new Error("caller lifecycle expired")
    await expect(assertPublicUrl(
      "https://mcp.example.test/mcp",
      AbortSignal.abort(reason),
    )).rejects.toBe(reason)
  })

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
