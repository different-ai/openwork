import { EGRESS_DIAGNOSTIC_ID_HEADER } from "@openwork/types/den/egress-diagnostics"
import { diagnosticsConfig } from "./config"
import { recordWireExchange } from "./history-store"
import { createWireExchange } from "./wire"

export type HandledResponse = { body: string; response: Response }

export function jsonResponse(status: number, value: unknown, headers: Readonly<Record<string, string>> = {}): HandledResponse {
  const body = JSON.stringify(value)
  return {
    body,
    response: new Response(body, {
      headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8", ...headers },
      status,
    }),
  }
}

export function emptyResponse(status: number, headers: Readonly<Record<string, string>> = {}): HandledResponse {
  return { body: "", response: new Response(null, { headers: { "cache-control": "no-store", ...headers }, status }) }
}

export async function readBoundedBody(request: Request, maximumBytes: number): Promise<{ body: string; tooLarge: boolean }> {
  if (!request.body) return { body: "", tooLarge: false }
  const reader = request.body.getReader()
  const decoder = new TextDecoder()
  let body = ""
  let receivedBytes = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) return { body: `${body}${decoder.decode()}`, tooLarge: false }
    receivedBytes += value.byteLength
    if (receivedBytes > maximumBytes) {
      await reader.cancel()
      return { body: "", tooLarge: true }
    }
    body += decoder.decode(value, { stream: true })
  }
}

export async function finalizeRecordedResponse(input: {
  request: Request
  requestBody: string
  handled: HandledResponse
  startedAt: number
}): Promise<Response> {
  const exchange = createWireExchange({
    profile: diagnosticsConfig().profile,
    request: input.request,
    requestBody: input.requestBody,
    response: input.handled.response,
    responseBody: input.handled.body,
    startedAt: input.startedAt,
  })
  try {
    await recordWireExchange(exchange)
  } catch (error) {
    console.error("diagnostics_wire_history_write_failed", { errorType: error instanceof Error ? error.name : typeof error })
    return new Response(JSON.stringify({
      error: "diagnostic_history_unavailable",
      referenceId: exchange.correlationId,
    }), {
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
        [EGRESS_DIAGNOSTIC_ID_HEADER]: exchange.correlationId,
      },
      status: 503,
    })
  }
  input.handled.response.headers.set(EGRESS_DIAGNOSTIC_ID_HEADER, exchange.correlationId)
  return input.handled.response
}
