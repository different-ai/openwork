import { diagnosticsConfig } from "../../src/config"
import { recordWireExchange } from "../../src/history-store"
import { handleMcpRequest, maximumRequestBytes } from "../../src/mcp"
import { createWireExchange } from "../../src/wire"

export const dynamic = "force-dynamic"
export const maxDuration = 10

async function readBoundedBody(request: Request): Promise<string> {
  if (request.method !== "POST" || !request.body) return ""

  const reader = request.body.getReader()
  const decoder = new TextDecoder()
  let body = ""
  let receivedBytes = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) return `${body}${decoder.decode()}`

    receivedBytes += value.byteLength
    if (receivedBytes > maximumRequestBytes) {
      await reader.cancel()
      return "x".repeat(maximumRequestBytes + 1)
    }
    body += decoder.decode(value, { stream: true })
  }
}

async function execute(request: Request): Promise<Response> {
  const startedAt = Date.now()
  const rawBody = await readBoundedBody(request)
  const handled = await handleMcpRequest(request, rawBody)
  const exchange = createWireExchange({
    profile: diagnosticsConfig().profile,
    request,
    requestBody: rawBody,
    response: handled.response,
    responseBody: handled.body,
    startedAt,
  })
  try {
    await recordWireExchange(exchange)
  } catch (error) {
    console.error("diagnostics_wire_history_write_failed", { errorType: error instanceof Error ? error.name : typeof error })
  }
  handled.response.headers.set("x-openwork-diagnostic-id", exchange.correlationId)
  return handled.response
}

export const POST = execute
export const DELETE = execute
export const GET = execute
