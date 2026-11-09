import { once } from "node:events"
import { createServer, type IncomingHttpHeaders } from "node:http"
import { z } from "zod"

export type GatewayProtocol = "openai" | "anthropic" | "openai-responses"
export type GatewayRequest = {
  method: string
  path: string
  headers: IncomingHttpHeaders
  model: string
  stream: boolean
  body: string
}

export async function closeHttpServer(server: { close: (callback: (error?: Error) => void) => unknown; closeAllConnections?: () => void }): Promise<void> {
  server.closeAllConnections?.()
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

const requestSchema = z.object({ model: z.string(), stream: z.boolean().optional() })

/** A local wire-protocol fixture, not a replacement model adapter or a provider SDK mock. */
export async function inferenceGateway(options: { concurrentStreams?: number; barrierTimeoutMs?: number } = {}) {
  const requests: GatewayRequest[] = []
  const errors: string[] = []
  let activeStreams = 0
  let maxConcurrentStreams = 0
  let releaseBarrier: () => void = () => undefined
  const barrier = new Promise<void>((resolve) => { releaseBarrier = resolve })
  const barrierTimer = setTimeout(() => {
    errors.push("Timed out waiting for concurrent inference requests")
    releaseBarrier()
  }, options.barrierTimeoutMs ?? 10_000)
  if ((options.concurrentStreams ?? 1) <= 1) {
    clearTimeout(barrierTimer)
    releaseBarrier()
  }
  const server = createServer(async (request, response) => {
    try {
      let body = ""
      for await (const chunk of request) {
        body += chunk
        if (body.length > 2_000_000) throw new Error("Fixture request exceeded 2 MB")
      }
      const parsed = requestSchema.parse(JSON.parse(body))
      const path = new URL(request.url ?? "/", "http://fixture").pathname
      const protocol = path.endsWith("/chat/completions") ? "openai"
        : path.endsWith("/messages") ? "anthropic"
          : path.endsWith("/responses") ? "openai-responses" : undefined
      if (request.method !== "POST" || !protocol) throw new Error(`Unexpected fixture request: ${request.method} ${path}`)
      requests.push({ method: request.method, path, headers: { ...request.headers }, model: parsed.model, stream: parsed.stream === true, body })
      if (parsed.stream) {
        activeStreams++
        maxConcurrentStreams = Math.max(maxConcurrentStreams, activeStreams)
        if (activeStreams >= (options.concurrentStreams ?? 1)) {
          clearTimeout(barrierTimer)
          releaseBarrier()
        }
        try {
          await barrier
          response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
          for (const event of streamEvents(protocol, parsed.model)) {
            response.write(`${"type" in event ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`)
          }
          if (protocol === "openai") response.write("data: [DONE]\n\n")
          response.end()
        } finally {
          activeStreams--
        }
      } else {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify(completion(protocol, parsed.model, "A short title")))
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
      response.writeHead(400, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: "fixture_request_invalid" }))
    }
  })
  server.requestTimeout = 15_000
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Fixture has no TCP address")
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    requests,
    errors,
    get maxConcurrentStreams() { return maxConcurrentStreams },
    async close() {
      clearTimeout(barrierTimer)
      releaseBarrier()
      await closeHttpServer(server)
    },
  }
}

function completion(protocol: GatewayProtocol, model: string, text: string) {
  if (protocol === "openai") return { id: "chat_fixture", object: "chat.completion", model, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } }
  if (protocol === "anthropic") return { id: "msg_fixture", type: "message", role: "assistant", model, content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 3 } }
  return { id: "resp_fixture", object: "response", model, status: "completed", output: [{ id: "msg_fixture", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }], usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } }
}

function streamEvents(protocol: GatewayProtocol, model: string) {
  if (protocol === "openai") return [
    { id: "chat_fixture", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { role: "assistant", content: "Done" }, finish_reason: null }] },
    { id: "chat_fixture", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } },
  ]
  if (protocol === "anthropic") return [
    { type: "message_start", message: { ...completion(protocol, model, ""), content: [], stop_reason: null } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } },
    { type: "message_stop" },
  ]
  return [
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Done" },
    { type: "response.completed", response: completion(protocol, model, "Done") },
  ]
}
