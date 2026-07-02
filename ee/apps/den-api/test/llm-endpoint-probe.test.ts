import { describe, expect, test } from "bun:test"

import {
  buildCandidateBaseUrls,
  detectVendor,
  probeEndpoint,
} from "../src/llm/endpoint-probe.js"

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const modelsPayload = (ids: string[]) => ({ data: ids.map((id) => ({ id, object: "model" })) })

describe("detectVendor", () => {
  test("recognizes Azure host families", () => {
    expect(detectVendor("https://res.openai.azure.com/openai/v1")).toBe("azure")
    expect(detectVendor("https://res.services.ai.azure.com/openai/v1")).toBe("azure")
    expect(detectVendor("https://res.cognitiveservices.azure.com")).toBe("azure")
    expect(detectVendor("https://llm.internal.example.com/v1")).toBe("openai-compatible")
  })
})

describe("buildCandidateBaseUrls", () => {
  test("strips known suffixes and trailing slashes", () => {
    expect(buildCandidateBaseUrls("https://x.example.com/v1/")[0]).toBe("https://x.example.com/v1")
    expect(buildCandidateBaseUrls("https://x.example.com/v1/chat/completions")[0]).toBe("https://x.example.com/v1")
    // The exact mistake from the Blue Yonder session: /responses pasted from the portal.
    expect(
      buildCandidateBaseUrls("https://r.services.ai.azure.com/openai/v1/responses")[0],
    ).toBe("https://r.services.ai.azure.com/openai/v1")
  })

  test("adds the Azure host twin and bare-origin /openai/v1 variants", () => {
    const candidates = buildCandidateBaseUrls("https://r.openai.azure.com/openai/v1")
    expect(candidates).toContain("https://r.openai.azure.com/openai/v1")
    expect(candidates).toContain("https://r.services.ai.azure.com/openai/v1")

    const bare = buildCandidateBaseUrls("https://r.openai.azure.com")
    expect(bare).toContain("https://r.openai.azure.com/openai/v1")
  })

  test("rejects garbage", () => {
    expect(buildCandidateBaseUrls("not a url")).toEqual([])
    expect(buildCandidateBaseUrls("ftp://x.example.com")).toEqual([])
  })
})

describe("probeEndpoint", () => {
  test("returns sorted deduped model ids from /models", async () => {
    const result = await probeEndpoint({
      api: "https://llm.example.com/v1",
      apiKey: "k",
      allowLoopback: false,
      fetchImpl: async (url) => {
        expect(url).toBe("https://llm.example.com/v1/models")
        return jsonResponse(200, modelsPayload(["gpt-5-mini", "dall-e-2", "gpt-5-mini"]))
      },
    })
    expect(result.ok).toBe(true)
    expect(result.normalizedApi).toBe("https://llm.example.com/v1")
    expect(result.models.map((m) => m.id)).toEqual(["dall-e-2", "gpt-5-mini"])
  })

  test("falls through to the Azure host twin when the first candidate 404s", async () => {
    const calls: string[] = []
    const result = await probeEndpoint({
      api: "https://r.openai.azure.com/openai/v1",
      apiKey: "k",
      allowLoopback: false,
      fetchImpl: async (url) => {
        calls.push(url)
        if (url.startsWith("https://r.services.ai.azure.com")) {
          return jsonResponse(200, modelsPayload(["gpt-5-mini"]))
        }
        return jsonResponse(404, { error: { code: "404" } })
      },
    })
    expect(result.ok).toBe(true)
    expect(result.normalizedApi).toBe("https://r.services.ai.azure.com/openai/v1")
    expect(calls[0]).toBe("https://r.openai.azure.com/openai/v1/models")
  })

  test("401 yields a key hint with the upstream status", async () => {
    const result = await probeEndpoint({
      api: "https://r.openai.azure.com/openai/v1",
      apiKey: "bad",
      allowLoopback: false,
      fetchImpl: async () => jsonResponse(401, { error: "unauthorized" }),
    })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(401)
    expect(result.hint).toContain("key")
  })

  test("blocks cloud metadata endpoints", async () => {
    const result = await probeEndpoint({
      api: "http://169.254.169.254/v1",
      apiKey: "k",
      allowLoopback: true,
      fetchImpl: async () => {
        throw new Error("must not be called")
      },
    })
    expect(result.ok).toBe(false)
    expect(result.hint).toContain("not allowed")
  })

  test("blocks loopback unless explicitly allowed", async () => {
    const blocked = await probeEndpoint({
      api: "http://127.0.0.1:9999/v1",
      apiKey: "k",
      allowLoopback: false,
      fetchImpl: async () => {
        throw new Error("must not be called")
      },
    })
    expect(blocked.ok).toBe(false)

    const allowed = await probeEndpoint({
      api: "http://127.0.0.1:9999/v1",
      apiKey: "k",
      allowLoopback: true,
      fetchImpl: async () => jsonResponse(200, modelsPayload(["m"])),
    })
    expect(allowed.ok).toBe(true)
  })

  test("network failure on every candidate yields the reachability hint", async () => {
    const result = await probeEndpoint({
      api: "https://nowhere.example.com/v1",
      apiKey: "k",
      allowLoopback: false,
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED")
      },
    })
    expect(result.ok).toBe(false)
    expect(result.status).toBeNull()
    expect(result.hint).toContain("reach")
  })
})
