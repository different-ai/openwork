import { describe, expect, test } from "bun:test"
import { createServer, type Server } from "node:http"
import { getRequestListener } from "@hono/node-server"
import { parseErrorResponse } from "@modelcontextprotocol/sdk/client/auth.js"
import { createRealmSafeFetch, normalizeResponseRealm } from "../src/capability-sources/url-guard.js"
import {
  EXTERNAL_MCP_JSON_RESPONSE_LIMIT_BYTES,
  ExternalMcpDiagnosticTracker,
  createExternalMcpDiagnosticFetch,
} from "../src/capability-sources/external-mcp-diagnostics.js"

getRequestListener(async () => new globalThis.Response("ok"))

const OAUTH_ERROR_BODY = JSON.stringify({
  error: "invalid_client_metadata",
  error_description: "redirect_uri not allowed",
})

function serverUrl(server: Server): string {
  const address = server.address()
  if (typeof address === "object" && address !== null) {
    return `http://127.0.0.1:${address.port}`
  }
  throw new Error("Test server did not bind to a TCP port.")
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })
  return serverUrl(server)
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
}

async function withLocalResponse(status: number, body: string, run: (url: string) => Promise<void>): Promise<void> {
  const server = createServer((_request, response) => {
    response.writeHead(status, { "content-type": "application/json" })
    response.end(body)
  })
  const url = await listen(server)
  try {
    await run(url)
  } finally {
    await close(server)
  }
}

describe("OAuth response realm normalization", () => {
  test("precondition: hono's global Response override is active", async () => {
    await withLocalResponse(400, OAUTH_ERROR_BODY, async (url) => {
      const response = await fetch(url)

      expect(new globalThis.Response("x").constructor).not.toBe(response.constructor)
      expect(response instanceof globalThis.Response).toBe(false)
    })
  })

  test("normalizes failing fetch responses into the current global Response realm", async () => {
    await withLocalResponse(400, OAUTH_ERROR_BODY, async (url) => {
      const response = await createRealmSafeFetch()(url)

      expect(response instanceof globalThis.Response).toBe(true)
      expect(response.status).toBe(400)
      expect(response.ok).toBe(false)
      expect(await response.text()).toBe(OAUTH_ERROR_BODY)
    })
  })

  test("lets the SDK parse OAuth errors instead of stringifying Response objects", async () => {
    await withLocalResponse(400, OAUTH_ERROR_BODY, async (url) => {
      const original = await fetch(url)
      const broken = await parseErrorResponse(original)

      expect(broken.message).toContain("[object Response]")

      const normalized = await createRealmSafeFetch()(url)
      const parsed = await parseErrorResponse(normalized)

      expect(parsed.message).toContain("redirect_uri not allowed")
      expect(parsed.message).not.toContain("[object Response]")
    })
  })

  test("leaves success responses untouched", async () => {
    await withLocalResponse(200, "ok", async (url) => {
      const response = await fetch(url)
      const normalized = await normalizeResponseRealm(response)

      expect(normalized).toBe(response)
      expect(await normalized.text()).toBe("ok")
    })
  })

  test("streams old-realm error bodies through the diagnostic byte ceiling before buffering", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(500, { "content-type": "application/json" })
      const chunk = Buffer.alloc(64 * 1024, 0x61)
      for (let sent = 0; sent <= EXTERNAL_MCP_JSON_RESPONSE_LIMIT_BYTES; sent += chunk.byteLength) {
        response.write(chunk)
      }
      response.end()
    })
    const url = await listen(server)
    try {
      const tracker = new ExternalMcpDiagnosticTracker("req_cross_realm_body_limit")
      const diagnosticFetch = createExternalMcpDiagnosticFetch({
        endpoint: `${url}/mcp`,
        tracker,
        fetch: createRealmSafeFetch(),
      })
      const bounded = await diagnosticFetch(`${url}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      })

      let bodyError: unknown
      try {
        await bounded.arrayBuffer()
      } catch (error) {
        bodyError = error
      }
      expect(bodyError).toBeDefined()
      expect(tracker.error(bodyError)).toMatchObject({
        diagnostic: {
          phase: "MCP_TOOL_DISCOVERY",
          category: "response_too_large",
          code: "MCP_RESPONSE_BODY_LIMIT",
        },
      })
    } finally {
      await close(server)
    }
  })
})
