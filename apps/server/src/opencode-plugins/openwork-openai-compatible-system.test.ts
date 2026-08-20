import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { OpenWorkOpenAiCompatibleSystem } from "./openwork-openai-compatible-system.js"

const calls: { input: unknown; init: RequestInit | undefined }[] = []
const fakeBase = Object.assign(async (input: unknown, init?: RequestInit) => {
  calls.push({ input, init })
  return new Response("{}")
}, globalThis.fetch)

const originalFetch = globalThis.fetch
let patchedFetch: typeof fetch

beforeAll(async () => {
  globalThis.fetch = fakeBase as unknown as typeof fetch
  await OpenWorkOpenAiCompatibleSystem()
  patchedFetch = globalThis.fetch
  globalThis.fetch = originalFetch
})

afterAll(() => {
  globalThis.fetch = originalFetch
})

const JSON_HEADERS = { "content-type": "application/json" }
const ANTHROPIC_HEADERS = { "anthropic-version": "2023-06-01", "content-type": "application/json" }

// Reproduces what Hetzner Inference (vLLM, Qwen3.8-27B) rejects with
// {"error":{"message":"System message must be at the beginning.","code":400}}
// once openwork-capabilities-knowledge and openwork-extensions-preview have
// each pushed their own entry onto `output.system`.
const openworkShapedRequest = {
  model: "Qwen3.8-27B",
  messages: [
    { role: "system", content: "You are OpenWork." },
    { role: "system", content: "OPENWORK_CAPABILITIES_KNOWLEDGE" },
    { role: "system", content: "routing instructions" },
    { role: "user", content: "hi" },
  ],
}

async function send(body: unknown, headers: Record<string, string> = JSON_HEADERS) {
  calls.length = 0
  await patchedFetch("https://inference.hetzner.com/api/v1/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })
  const sent = calls[0]?.init?.body
  return typeof sent === "string" ? JSON.parse(sent) : undefined
}

describe("OpenWorkOpenAiCompatibleSystem", () => {
  test("merges consecutive leading system messages into one", async () => {
    const sent = await send(openworkShapedRequest)
    expect(sent.messages).toEqual([
      {
        role: "system",
        content: "You are OpenWork.\n\nOPENWORK_CAPABILITIES_KNOWLEDGE\n\nrouting instructions",
      },
      { role: "user", content: "hi" },
    ])
  })

  test("leaves a single system message untouched", async () => {
    const body = { model: "m", messages: [{ role: "system", content: "A" }, { role: "user", content: "hi" }] }
    const sent = await send(body)
    expect(sent).toEqual(body)
  })

  test("leaves a request without any system message untouched", async () => {
    const body = { model: "m", messages: [{ role: "user", content: "hi" }] }
    const sent = await send(body)
    expect(sent).toEqual(body)
  })

  test("does not reorder a system message that appears mid-conversation", async () => {
    const body = {
      model: "m",
      messages: [
        { role: "system", content: "A" },
        { role: "user", content: "hi" },
        { role: "system", content: "late" },
      ],
    }
    const sent = await send(body)
    expect(sent).toEqual(body)
  })

  test("keeps structured content parts as an array", async () => {
    const sent = await send({
      model: "m",
      messages: [
        { role: "system", content: [{ type: "text", text: "A" }] },
        { role: "system", content: "B" },
        { role: "user", content: "hi" },
      ],
    })
    expect(sent.messages[0].content).toEqual([
      { type: "text", text: "A" },
      { type: "text", text: "B" },
    ])
  })

  test("preserves other fields on the merged message and on the body", async () => {
    const sent = await send({
      model: "m",
      temperature: 0.2,
      messages: [
        { role: "system", content: "A", name: "primary" },
        { role: "system", content: "B" },
        { role: "user", content: "hi" },
      ],
    })
    expect(sent.temperature).toBe(0.2)
    expect(sent.messages[0].name).toBe("primary")
  })

  test("ignores anthropic requests so system blocks keep their cache breakpoints", async () => {
    const sent = await send(openworkShapedRequest, ANTHROPIC_HEADERS)
    expect(sent).toEqual(openworkShapedRequest)
  })

  test("forwards a non-JSON body unchanged", async () => {
    calls.length = 0
    await patchedFetch("https://inference.hetzner.com/api/v1/chat/completions", {
      method: "POST",
      headers: JSON_HEADERS,
      body: 'not json but mentions "system"',
    })
    expect(calls[0]?.init?.body).toBe('not json but mentions "system"')
  })
})
