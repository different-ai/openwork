import { afterEach, describe, expect, test } from "bun:test"
import {
  accessKeyMatches,
  allowedUpstreamOverride,
  connectDebugProxyConfig,
  encodeUpstreamParameter,
} from "../src/connect-debug-proxy-config"
import {
  CONNECT_DEBUG_PROXY_BROWSER_ROUTE_COOKIE,
  connectDebugProxyBrowserRouteCookie,
  readConnectDebugProxyBrowserRoute,
} from "../src/connect-debug-proxy-browser-route"
import { proxyConnectDebugRequest } from "../src/connect-debug-proxy"
import { clearConnectDebugProxyFlakyWindows, connectDebugProxyFault } from "../src/connect-debug-proxy-faults"
import { clearConnectDebugProxyRequests, listConnectDebugProxyRequests } from "../src/connect-debug-proxy-log"
import {
  buildConnectDebugProxyResponse,
  forwardRequestHeaders,
  rewriteLocationHeader,
  rewriteSetCookieHeader,
} from "../src/connect-debug-proxy-rewrite"
import { parseConnectDebugProxyScenario } from "../src/connect-debug-proxy-scenarios"
import { tamperJsonRpcText, tamperSseText } from "../src/connect-debug-proxy-tamper"

const originalEnvironment = { ...process.env }

afterEach(() => {
  process.env = { ...originalEnvironment }
  clearConnectDebugProxyFlakyWindows()
  clearConnectDebugProxyRequests()
})

function scenario(slug: string) {
  const parsed = parseConnectDebugProxyScenario(slug)
  if (!parsed) throw new Error(`Unknown test scenario: ${slug}`)
  return parsed
}

function fault(slug: string, pathname: string, now = 1_000) {
  return connectDebugProxyFault({
    flakyKey: `${slug}:${pathname}`,
    flakyWindowMs: 60_000,
    now,
    pathname,
    requestBody: new TextEncoder().encode('{"jsonrpc":"2.0","method":"tools/list"}'),
    scenario: scenario(slug),
    slowMs: 7_000,
  })
}

describe("Connect debug proxy configuration", () => {
  test("accepts only encoded origins whose host is allowlisted", () => {
    delete process.env.VERCEL
    process.env.DEBUG_PROXY_DEFAULT_UPSTREAM = "https://app.openworklabs.com"
    process.env.DEBUG_PROXY_ALLOWED_UPSTREAMS = "staging.openworklabs.com,http://127.0.0.1:4545"
    const config = connectDebugProxyConfig()
    expect(allowedUpstreamOverride(encodeUpstreamParameter("https://staging.openworklabs.com"), config)).toBe("https://staging.openworklabs.com")
    expect(allowedUpstreamOverride(encodeUpstreamParameter("http://127.0.0.1:4545"), config)).toBe("http://127.0.0.1:4545")
    expect(allowedUpstreamOverride(encodeUpstreamParameter("https://evil.example"), config)).toBeNull()
    expect(allowedUpstreamOverride("~not-canonical-base64", config)).toBeNull()
  })

  test("requires a path-safe access key on Vercel and compares it safely", () => {
    process.env.VERCEL = "1"
    process.env.DEBUG_PROXY_ACCESS_KEY = "short"
    expect(connectDebugProxyConfig().errors).toContain("DEBUG_PROXY_ACCESS_KEY")
    process.env.DEBUG_PROXY_ACCESS_KEY = "debug-access-key-1234"
    expect(connectDebugProxyConfig().errors).not.toContain("DEBUG_PROXY_ACCESS_KEY")
    expect(accessKeyMatches("debug-access-key-1234", "debug-access-key-1234")).toBe(true)
    expect(accessKeyMatches("wrong", "debug-access-key-1234")).toBe(false)
  })
})

describe("Connect debug proxy fault engine", () => {
  test("scopes endpoint faults without breaking unrelated Den routes", async () => {
    expect(fault("auth-expired", "/v1/mcp/token")).toBeNull()
    const auth = fault("auth-expired", "/api/den/mcp/agent")
    expect(auth?.kind).toBe("response")
    if (auth?.kind !== "response") throw new Error("Expected auth response")
    expect(auth.response.status).toBe(401)
    expect(auth.response.headers.get("www-authenticate")).toContain("invalid_token")

    expect(fault("token-mint-fail", "/api/den/mcp/agent")).toBeNull()
    const mint = fault("token-mint-fail", "/v1/mcp/token")
    expect(mint?.kind).toBe("response")
    if (mint?.kind !== "response") throw new Error("Expected token mint response")
    expect(mint.response.status).toBe(503)
    expect(fault("token-mint-fail", "/api/den/v1/mcp/token")?.kind).toBe("response")
  })

  test("fails only the first N agent requests in each rolling window", () => {
    for (let index = 0; index < 3; index += 1) expect(fault("flaky-3", "/api/den/mcp/agent", 1_000)?.kind).toBe("response")
    expect(fault("flaky-3", "/api/den/mcp/agent", 1_000)).toBeNull()
    expect(fault("flaky-3", "/api/den/mcp/agent", 62_000)?.kind).toBe("response")
  })

  test("implements every named fault action and keeps default as pass-through", async () => {
    expect(fault("default", "/api/den/mcp/agent")).toBeNull()
    const expectations = [
      ["forbidden", "response", 403],
      ["down", "response", 502],
      ["corrupt", "response", 200],
      ["slow", "delay", null],
      ["hang", "hang", null],
      ["missing-tools", "tamper", null],
      ["bad-protocol", "tamper", null],
    ]
    for (const [slug, kind, status] of expectations) {
      if (typeof slug !== "string") throw new Error("Expected scenario slug")
      const action = fault(slug, "/api/den/mcp/agent")
      expect(action?.kind).toBe(kind)
      if (status !== null && action?.kind === "response") expect(action.response.status).toBe(status)
    }
    const outage = fault("den-outage", "/v1/me")
    expect(outage?.kind).toBe("response")
    if (outage?.kind !== "response") throw new Error("Expected outage response")
    expect(outage.response.status).toBe(503)
  })
})

describe("Connect debug proxy rewriting and streaming", () => {
  test("rewrites upstream Location, absolute JSON URLs, and cookie scope", async () => {
    const upstreamUrl = new URL("https://api.openworklabs.com/v1/session")
    const proxyBase = "https://proxy.example/via/default/access-key"
    expect(rewriteLocationHeader("/login?next=%2F", upstreamUrl, proxyBase)).toBe(`${proxyBase}/login?next=%2F`)
    expect(rewriteLocationHeader("https://identity.example/login", upstreamUrl, proxyBase)).toBe("https://identity.example/login")
    expect(rewriteSetCookieHeader("session=value; Domain=api.openworklabs.com; Path=/; Secure; HttpOnly", "/via/default/access-key"))
      .toBe("session=value;Path=/via/default/access-key; Secure; HttpOnly")
    expect(rewriteSetCookieHeader("session=value; Path=/api; Secure", "/")).toBe("session=value;Path=/api; Secure")

    const response = await buildConnectDebugProxyResponse({
      proxyBase,
      tamperMode: null,
      upstream: Response.json({ redirect: "https://api.openworklabs.com/next" }),
      upstreamRequestUrl: upstreamUrl,
    })
    expect(await response.json()).toEqual({ redirect: `${proxyBase}/next` })
  })

  test("keeps the desktop auth handoff on the selected proxy base", async () => {
    const upstreamUrl = new URL("https://app.openworklabs.com/api/den/v1/auth/desktop-handoff")
    const proxyBase = "https://proxy.example/via/default/access-key"
    const upstreamDenBaseUrl = "https://app.openworklabs.com/api/den"
    const deepLink = `openwork://den-auth?grant=one-time-grant&denBaseUrl=${encodeURIComponent(upstreamDenBaseUrl)}`

    expect(rewriteLocationHeader(deepLink, upstreamUrl, proxyBase)).toBe(
      `openwork://den-auth?grant=one-time-grant&denBaseUrl=${encodeURIComponent(`${proxyBase}/api/den`)}`,
    )

    const response = await buildConnectDebugProxyResponse({
      proxyBase,
      tamperMode: null,
      upstream: Response.json({ openworkUrl: deepLink }),
      upstreamRequestUrl: upstreamUrl,
    })
    const payload = await response.json() as { openworkUrl: string }
    expect(new URL(payload.openworkUrl).searchParams.get("denBaseUrl")).toBe(`${proxyBase}/api/den`)
  })

  test("keeps the proxy key private while translating same-origin browser headers", () => {
    const headers = forwardRequestHeaders(new Headers({
      "x-connect-debug-proxy-key": "do-not-forward",
      origin: "https://proxy.example",
      referer: "https://proxy.example/via/default/access-key/login?next=1",
      cookie: `${CONNECT_DEBUG_PROXY_BROWSER_ROUTE_COOKIE}=%2Fvia%2Fdefault%2Faccess-key; den-session=opaque`,
    }), {
      proxyBase: "https://proxy.example/via/default/access-key",
      upstreamOrigin: "https://api.openworklabs.com",
    })
    expect(headers.has("x-connect-debug-proxy-key")).toBe(false)
    expect(headers.get("origin")).toBe("https://api.openworklabs.com")
    expect(headers.get("referer")).toBe("https://api.openworklabs.com/login?next=1")
    expect(headers.get("cookie")).toBe("den-session=opaque")
  })

  test("sets a short-lived browser route without exposing it to Den", async () => {
    delete process.env.VERCEL
    process.env.DEBUG_PROXY_ACCESS_KEY = "debug-access-key-1234"
    process.env.DEBUG_PROXY_DEFAULT_UPSTREAM = "https://app.openworklabs.com"
    let forwardedCookie = ""
    const response = await proxyConnectDebugRequest({
      pathSegments: ["debug-access-key-1234"],
      request: new Request("https://proxy.example/via/default/debug-access-key-1234?desktopAuth=1", {
        headers: { accept: "text/html", cookie: `${CONNECT_DEBUG_PROXY_BROWSER_ROUTE_COOKIE}=%2Fvia%2Fdefault%2Fdebug-access-key-1234; den-session=opaque` },
      }),
      scenarioSlug: "default",
    }, {
      fetchImpl: async (_url, init) => {
        forwardedCookie = new Headers(init?.headers).get("cookie") ?? ""
        return new Response("<html>Den</html>", {
          headers: { "content-type": "text/html", "set-cookie": "den-session=next; Path=/; Secure; HttpOnly" },
        })
      },
    })
    const cookies = response.headers.getSetCookie()
    const routeCookie = cookies.find((cookie) => cookie.startsWith(`${CONNECT_DEBUG_PROXY_BROWSER_ROUTE_COOKIE}=`))

    expect(forwardedCookie).toBe("den-session=opaque")
    expect(cookies).toContain("den-session=next;Path=/; Secure; HttpOnly")
    expect(routeCookie).toContain("HttpOnly")
    expect(routeCookie).toContain("SameSite=Lax")
    expect(readConnectDebugProxyBrowserRoute(routeCookie)).toBe("/via/default/debug-access-key-1234")
    expect(connectDebugProxyBrowserRouteCookie("http://localhost:3010/via/default/local-connect-debug-proxy")).not.toContain("Secure")
  })

  test("passes SSE through without waiting for the stream to finish", async () => {
    let release: (() => void) | undefined
    const secondChunk = new Promise<void>((resolve) => { release = resolve })
    const encoder = new TextEncoder()
    const upstreamBody = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode("event: message\ndata: first\n\n"))
        await secondChunk
        controller.enqueue(encoder.encode("event: message\ndata: second\n\n"))
        controller.close()
      },
    })
    const response = await buildConnectDebugProxyResponse({
      proxyBase: "https://proxy.example/via/default/access-key",
      tamperMode: null,
      upstream: new Response(upstreamBody, { headers: { "content-type": "text/event-stream" } }),
      upstreamRequestUrl: new URL("https://api.openworklabs.com/mcp/agent"),
    })
    const reader = response.body?.getReader()
    if (!reader) throw new Error("Expected streamed body")
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toContain("first")
    release?.()
    const second = await reader.read()
    expect(new TextDecoder().decode(second.value)).toContain("second")
  })

  test("rewrites chunked JSON without buffering the complete response", async () => {
    let release: (() => void) | undefined
    const secondChunk = new Promise<void>((resolve) => { release = resolve })
    const encoder = new TextEncoder()
    const upstreamBody = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(`{"padding":"${"x".repeat(80)}","url":"https://api.openworklabs.com`))
        await secondChunk
        controller.enqueue(encoder.encode(`/next"}`))
        controller.close()
      },
    })
    const response = await buildConnectDebugProxyResponse({
      proxyBase: "https://proxy.example/via/default/access-key",
      tamperMode: null,
      upstream: new Response(upstreamBody, { headers: { "content-type": "application/json" } }),
      upstreamRequestUrl: new URL("https://api.openworklabs.com/mcp/agent"),
    })
    const reader = response.body?.getReader()
    if (!reader) throw new Error("Expected streamed body")
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toContain("padding")
    release?.()
    let text = new TextDecoder().decode(first.value)
    while (true) {
      const next = await reader.read()
      if (next.done) break
      text += new TextDecoder().decode(next.value)
    }
    expect(JSON.parse(text)).toEqual({ padding: "x".repeat(80), url: "https://proxy.example/via/default/access-key/next" })
  })

  test("drops execute_capability from plain JSON and SSE tools/list responses", () => {
    const payload = { jsonrpc: "2.0", id: 2, result: { tools: [{ name: "search_capabilities" }, { name: "execute_capability" }] } }
    const plain = JSON.parse(tamperJsonRpcText(JSON.stringify(payload), "missing-tools"))
    expect(plain.result.tools).toEqual([{ name: "search_capabilities" }])
    const sse = tamperSseText(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, "missing-tools")
    expect(sse).toContain("search_capabilities")
    expect(sse).not.toContain("execute_capability")
  })

  test("rewrites initialize protocolVersion in plain JSON and SSE", () => {
    const payload = { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: {} } }
    expect(tamperJsonRpcText(JSON.stringify(payload), "bad-protocol")).toContain("1900-01-01")
    expect(tamperSseText(`data: ${JSON.stringify(payload)}\n\n`, "bad-protocol")).toContain("1900-01-01")
  })

  test("keeps the bad protocol header consistent with the tampered initialize payload", async () => {
    const response = await buildConnectDebugProxyResponse({
      proxyBase: "https://proxy.example/via/bad-protocol/access-key",
      tamperMode: "bad-protocol",
      upstream: Response.json({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } }, {
        headers: { "mcp-protocol-version": "2025-06-18" },
      }),
      upstreamRequestUrl: new URL("https://app.openworklabs.com/api/den/mcp/agent"),
    })
    expect(response.headers.get("mcp-protocol-version")).toBe("1900-01-01")
    expect(await response.text()).toContain("1900-01-01")
  })
})

describe("Connect debug proxy request handling", () => {
  test("preserves credentials in transit but retains only redacted request metadata", async () => {
    delete process.env.VERCEL
    process.env.DEBUG_PROXY_ACCESS_KEY = "debug-access-key-1234"
    process.env.DEBUG_PROXY_DEFAULT_UPSTREAM = "https://app.openworklabs.com"
    let forwardedAuthorization = ""
    let forwardedCookie = ""
    let forwardedBody = ""
    const response = await proxyConnectDebugRequest({
      pathSegments: ["debug-access-key-1234", "v1", "mcp", "token"],
      request: new Request("https://proxy.example/via/default/debug-access-key-1234/v1/mcp/token?token=query-secret", {
        body: '{"refreshToken":"body-secret"}',
        headers: { authorization: "Bearer header-secret", cookie: "session=cookie-secret", "content-type": "application/json" },
        method: "POST",
      }),
      scenarioSlug: "default",
    }, {
      fetchImpl: async (_url, init) => {
        const headers = new Headers(init?.headers)
        forwardedAuthorization = headers.get("authorization") ?? ""
        forwardedCookie = headers.get("cookie") ?? ""
        forwardedBody = new TextDecoder().decode(init?.body instanceof Uint8Array ? init.body : undefined)
        return Response.json({ ok: true })
      },
      now: () => 5_000,
    })
    expect(response.status).toBe(200)
    expect(forwardedAuthorization).toBe("Bearer header-secret")
    expect(forwardedCookie).toBe("session=cookie-secret")
    expect(forwardedBody).toContain("body-secret")
    expect(listConnectDebugProxyRequests()).toEqual([expect.objectContaining({
      method: "POST",
      path: "/v1/mcp/token",
      scenario: "default",
      status: 200,
    })])
    expect(JSON.stringify(listConnectDebugProxyRequests())).not.toContain("secret")
  })
})
