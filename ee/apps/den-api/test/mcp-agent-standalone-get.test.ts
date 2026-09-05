import { expect, test } from "bun:test"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { rejectStandaloneSseResponse } from "../src/mcp/standalone-sse.js"

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test("standalone GET rejection is method-specific and bodyless", async () => {
  const response = rejectStandaloneSseResponse()

  expect(response.status).toBe(405)
  expect(response.headers.get("allow")).toBe("POST")
  expect(await response.text()).toBe("")
})

test("MCP SDK does not retry a standalone GET after Den returns 405", async () => {
  let getRequests = 0
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      if (request.method === "GET") {
        getRequests += 1
        return rejectStandaloneSseResponse()
      }
      return new Response(null, { status: 202 })
    },
  })
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`))

  try {
    await transport.start()
    await transport.send({ jsonrpc: "2.0", method: "notifications/initialized" })
    while (getRequests === 0) await sleep(10)
    expect(getRequests).toBe(1)

    await sleep(2_250)
    expect(getRequests).toBe(1)
  } finally {
    await transport.close()
    await server.stop(true)
  }
}, 5_000)
