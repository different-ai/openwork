import { handleMcpRequest, maximumRequestBytes } from "../../src/mcp"
import { finalizeRecordedResponse, readBoundedBody } from "../../src/recorded-route"

export const dynamic = "force-dynamic"
export const maxDuration = 10

async function execute(request: Request): Promise<Response> {
  const startedAt = Date.now()
  const bounded = request.method === "POST"
    ? await readBoundedBody(request, maximumRequestBytes)
    : { body: "", tooLarge: false }
  const rawBody = bounded.tooLarge ? "x".repeat(maximumRequestBytes + 1) : bounded.body
  const handled = await handleMcpRequest(request, rawBody)
  return finalizeRecordedResponse({ request, requestBody: rawBody, handled, startedAt })
}

export const POST = execute
export const DELETE = execute
export const GET = execute
