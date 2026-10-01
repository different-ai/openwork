import { describe, expect, test } from "bun:test"
import { debuggerUrlFor, endpointUrl, readBrowserVersion } from "./cdp"
import { isCloudBrowserError } from "./contract"

describe("reaching Chrome through a proxy", () => {
  test("debugger URLs move onto the endpoint's scheme, host and query", () => {
    expect(debuggerUrlFor("https://9222-token.proxy.daytona.works", "ws://127.0.0.1:9222/devtools/browser/abc"))
      .toBe("wss://9222-token.proxy.daytona.works/devtools/browser/abc")
    expect(debuggerUrlFor("http://127.0.0.1:53111", "ws://localhost:9222/devtools/page/1"))
      .toBe("ws://127.0.0.1:53111/devtools/page/1")
    expect(debuggerUrlFor("https://proxy.example/cdp?token=t", "ws://127.0.0.1:9222/devtools/browser/abc"))
      .toBe("wss://proxy.example/cdp/devtools/browser/abc?token=t")
  })

  test("endpoint paths keep provider query parameters", () => {
    expect(endpointUrl({ cdpUrl: "https://9222-token.proxy.daytona.works" }, "/json/version")).toBe("https://9222-token.proxy.daytona.works/json/version")
    expect(endpointUrl({ cdpUrl: "https://proxy.example/cdp/?token=t" }, "/json/list")).toBe("https://proxy.example/cdp/json/list?token=t")
  })

  test("version probes send provider headers and report a missing browser as not_running", async () => {
    const seen: Array<{ url: string; headers: Headers }> = []
    const answering: typeof fetch = async (input, init) => {
      seen.push({ url: String(input), headers: new Headers(init?.headers) })
      return Response.json({ Browser: "Chrome/140", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/x" })
    }
    const endpoint = { cdpUrl: "https://9222-token.proxy.daytona.works", headers: { "X-Daytona-Skip-Preview-Warning": "true" }, expiresAt: null }
    expect(await readBrowserVersion(endpoint, { fetch: answering })).toEqual({
      browser: "Chrome/140",
      webSocketDebuggerUrl: "wss://9222-token.proxy.daytona.works/devtools/browser/x",
    })
    expect(seen[0]?.headers.get("x-daytona-skip-preview-warning")).toBe("true")

    for (const failing of [
      async () => { throw new TypeError("fetch failed") },
      async () => new Response("Sandbox stopped", { status: 502 }),
      async () => new Response("<html>preview warning</html>", { status: 200 }),
    ]) {
      const error = await readBrowserVersion(endpoint, { fetch: failing }).then(() => null, (caught: unknown) => caught)
      expect(isCloudBrowserError(error) && error.code).toBe("not_running")
    }
  })
})
