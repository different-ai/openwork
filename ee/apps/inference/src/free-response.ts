import type { FreeSettlement } from "./free-allowance.js"

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// Observe only the free path's authenticated upstream response. Forward its
// original bytes; never derive cost from token counts, text or an estimate.
export function meterFreeResponse(body: ReadableStream<Uint8Array> | null, input: {
  streaming: boolean
  identity: Pick<FreeSettlement, "requestId" | "inferenceKeyId" | "orgMembershipId" | "requestModel">
  settle: (receipt: FreeSettlement) => Promise<boolean>
}) {
  if (!body) return body
  const reader = body.getReader()
  const decoder = new TextDecoder("utf-8", { fatal: true })
  const maxBufferedCharacters = 1_048_576
  let pending = ""
  let dataLines = ""
  let valid = true
  let terminal = false
  let done = false
  let attempted = false
  let generationId: string | null = null
  let model: string | null = null
  let cost: number | null = null

  function accept(text: string) {
    if (done) { valid = false; return }
    if (text.trim() === "[DONE]") { done = true; return }
    const payload: unknown = JSON.parse(text)
    if (!record(payload) || payload.error) { valid = false; return }
    if (payload.id !== undefined) {
      if (typeof payload.id !== "string" || !payload.id || payload.id.length > 255 || generationId !== null && generationId !== payload.id) { valid = false; return }
      generationId = payload.id
    }
    if (payload.model !== undefined) {
      if (typeof payload.model !== "string" || payload.model !== input.identity.requestModel || model !== null && model !== payload.model) { valid = false; return }
      model = payload.model
    }
    if (payload.choices !== undefined) {
      if (!Array.isArray(payload.choices) || payload.choices.length > 1) { valid = false; return }
      for (const choice of payload.choices) {
        if (!record(choice) || choice.index !== 0) { valid = false; return }
        if (choice.finish_reason != null) {
          if (!["stop", "length", "tool_calls", "function_call", "content_filter"].includes(String(choice.finish_reason))) { valid = false; return }
          terminal = true
        }
      }
    }
    if (record(payload.usage) && payload.usage.cost !== undefined) {
      const value = payload.usage.cost
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || cost !== null && cost !== value) { valid = false; return }
      cost = value
    }
  }

  function observe(bytes: Uint8Array) {
    if (!valid || attempted) return
    try {
      pending += decoder.decode(bytes, { stream: true })
      if (pending.length + dataLines.length > maxBufferedCharacters) throw new Error("Accounting frame too large")
      if (!input.streaming) return
      let newline: number
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline).replace(/\r$/, "")
        pending = pending.slice(newline + 1)
        if (!line) {
          if (dataLines) accept(dataLines)
          dataLines = ""
        } else if (line.startsWith("data:")) {
          const data = line.slice(5).replace(/^ /, "")
          dataLines += `${dataLines ? "\n" : ""}${data}`
        } else if (line.startsWith("event:") && line.slice(6).trim() === "error") {
          valid = false
        }
      }
    } catch {
      valid = false
      pending = ""
      dataLines = ""
    }
  }

  async function settle() {
    if (attempted || !valid || !terminal || !generationId || !model || cost === null || input.streaming && !done) return
    attempted = true
    try {
      await input.settle({ ...input.identity, responseModel: model, currency: "USD", eventId: generationId, costUsd: cost })
    } catch {
      // Failed/missing settlement leaves the SQL hold for the authenticated
      // webhook. Do not truncate a valid reply or free the slot speculatively.
      console.error("[free-inference] response settlement deferred", { requestId: input.identity.requestId })
    }
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read()
        if (chunk.done) {
          if (!input.streaming && valid) {
            try { pending += decoder.decode(); accept(pending) } catch { valid = false }
            await settle()
          }
          controller.close()
          return
        }
        observe(chunk.value)
        // A complete final usage + DONE receipt settles before DONE reaches the
        // engine, so its next function-tool turn can acquire the person slot.
        if (input.streaming && done) await settle()
        controller.enqueue(chunk.value)
      } catch (error) {
        controller.error(error)
      }
    },
    async cancel(reason) { await reader.cancel(reason) },
  })
}
