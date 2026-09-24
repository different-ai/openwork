import { expect, test } from "bun:test"
import { gatewayBrowserEndpoint } from "../../den-web/app/gateway/connect/gateway-browser-endpoint"
import { denApiCredentials, setDenApiOriginOverride } from "../../den-web/app/(den)/_lib/den-api-origin"

test("standalone bridge waits for runtime API configuration for both continuation and signout", async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  const originalFetch = globalThis.fetch
  const calls: string[] = []
  let complete: (value: Response) => void = () => { throw new Error("Runtime request not started") }
  const runtimeResponse = new Promise<Response>((resolve) => { complete = resolve })
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { origin: "http://localhost:3005" } } })
  const fakeFetch: typeof fetch = Object.assign(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    calls.push(url)
    if (url !== "/api/runtime-config") throw new Error("Unexpected network request")
    return runtimeResponse
  }, { preconnect: originalFetch.preconnect })
  globalThis.fetch = fakeFetch
  setDenApiOriginOverride(null)
  try {
    let resolved = false
    const continuePath = "/v1/inference-providers/oauth/browser-start?attempt=entry.fixture"
    const pending = gatewayBrowserEndpoint(continuePath).then((endpoint) => { resolved = true; return endpoint })
    await Promise.resolve()
    expect(resolved).toBe(false)
    expect(calls).toEqual(["/api/runtime-config"])
    complete(Response.json({ denApiUrl: "http://localhost:18790" }))
    const endpoint = await pending
    expect(endpoint).toBe(`http://localhost:18790${continuePath}`)
    expect(denApiCredentials(endpoint)).toBe("include")
    expect(await gatewayBrowserEndpoint("/api/auth/sign-out")).toBe("http://localhost:18790/api/auth/sign-out")
    expect(calls).toHaveLength(1)
  } finally {
    globalThis.fetch = originalFetch
    setDenApiOriginOverride(null)
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow)
    else Reflect.deleteProperty(globalThis, "window")
  }
})
