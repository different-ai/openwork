import assert from "node:assert/strict"
import { test } from "node:test"
import { connectCallbackPage } from "../src/capability-sources/oauth-callback-page.js"
import { verifyLiteLlmEntraToken } from "../src/llm/litellm.js"

const BASE_URL = "https://litellm.example.com"
const TOKEN = "entra-access-token-secret-fixture"

test("verifyLiteLlmEntraToken verifies matching models and warns when configured models are missing", async () => {
  const seenAuth: string[] = []
  const ok = await verifyLiteLlmEntraToken({
    baseUrl: BASE_URL,
    accessToken: TOKEN,
    configuredModels: ["gpt-6.1-terra", "gpt-6.2-sol"],
    fetchImpl: async (url, init) => {
      assert.equal(String(url), `${BASE_URL}/v1/models`)
      const headers = new Headers(init?.headers)
      seenAuth.push(headers.get("authorization") ?? "")
      return Response.json({ data: [{ id: "gpt-6.1-terra" }, { id: "GPT-6.2-SOL" }] })
    },
  })
  assert.deepEqual(ok, { outcome: "verified", listedCount: 2 })
  assert.deepEqual(seenAuth, [`Bearer ${TOKEN}`])

  const missing = await verifyLiteLlmEntraToken({
    baseUrl: BASE_URL,
    accessToken: TOKEN,
    configuredModels: ["gpt-6.1-terra", "gpt-6.2-sol", "gpt-6.2-astra"],
    fetchImpl: async () => Response.json({ data: [{ id: "gpt-6.1-terra" }] }),
  })
  assert.equal(missing.outcome, "missing_models")
  if (missing.outcome === "missing_models") {
    assert.deepEqual(missing.missingModels, ["gpt-6.2-sol", "gpt-6.2-astra"])
    assert.match(missing.warning, /gpt-6\.2-sol, gpt-6\.2-astra/)
    assert.doesNotMatch(missing.warning, new RegExp(TOKEN))
  }
})

test("verifyLiteLlmEntraToken classifies 401/403 rejections without echoing raw text or tokens", async () => {
  const jwtErr = await verifyLiteLlmEntraToken({
    baseUrl: BASE_URL,
    accessToken: TOKEN,
    configuredModels: ["gpt-6.1-terra"],
    fetchImpl: async () => Response.json(
      { error: { message: `Invalid issuer for token ${TOKEN}` } },
      { status: 401 },
    ),
  })
  assert.equal(jwtErr.outcome, "rejected")
  if (jwtErr.outcome === "rejected") {
    assert.equal(jwtErr.status, 401)
    assert.equal(jwtErr.reason, "jwt_mismatch")
    assert.match(jwtErr.warning, /issuer, audience, and v2 access token settings/)
    assert.doesNotMatch(jwtErr.warning, new RegExp(TOKEN))
  }

  const missingUser = await verifyLiteLlmEntraToken({
    baseUrl: BASE_URL,
    accessToken: TOKEN,
    configuredModels: ["gpt-6.1-terra"],
    fetchImpl: async () => Response.json(
      { error: { message: "User not found in DB" } },
      { status: 401 },
    ),
  })
  assert.equal(missingUser.outcome, "rejected")
  if (missingUser.outcome === "rejected") {
    assert.equal(missingUser.reason, "user_not_found")
    assert.match(missingUser.warning, /user_id_upsert/)
  }

  const denied = await verifyLiteLlmEntraToken({
    baseUrl: BASE_URL,
    accessToken: TOKEN,
    configuredModels: ["gpt-6.1-terra"],
    fetchImpl: async () => Response.json(
      { error: { message: "Budget has been exceeded" } },
      { status: 403 },
    ),
  })
  assert.equal(denied.outcome, "rejected")
  if (denied.outcome === "rejected") {
    assert.equal(denied.status, 403)
    assert.equal(denied.reason, "budget_exceeded")
    assert.match(denied.warning, /budget limit/)
  }
})

test("verifyLiteLlmEntraToken fails open on network errors, non-auth statuses and invalid URLs", async () => {
  const unreachable = await verifyLiteLlmEntraToken({
    baseUrl: BASE_URL,
    accessToken: TOKEN,
    configuredModels: ["gpt-6.1-terra"],
    fetchImpl: async () => { throw new Error("network down") },
  })
  assert.deepEqual(unreachable, { outcome: "skipped", status: null, reason: "unreachable" })

  const serverError = await verifyLiteLlmEntraToken({
    baseUrl: BASE_URL,
    accessToken: TOKEN,
    configuredModels: ["gpt-6.1-terra"],
    fetchImpl: async () => new Response("bad gateway", { status: 502 }),
  })
  assert.deepEqual(serverError, { outcome: "skipped", status: 502, reason: "bad_response" })

  const badUrl = await verifyLiteLlmEntraToken({
    baseUrl: "not-a-url",
    accessToken: TOKEN,
    configuredModels: ["gpt-6.1-terra"],
  })
  assert.deepEqual(badUrl, { outcome: "skipped", status: null, reason: "invalid_url" })
})

test("connectCallbackPage renders verified detail and escaped warning notice when supplied", () => {
  const verified = connectCallbackPage({ ok: true, name: "Microsoft sign-in", detail: "Connection verified with LiteLLM." })
  assert.match(verified, /Connection verified with LiteLLM\./)
  assert.doesNotMatch(verified, /LiteLLM needs attention/)

  const warned = connectCallbackPage({ ok: true, name: "Microsoft sign-in", warning: "Missing <model> access." })
  assert.match(warned, /LiteLLM needs attention/)
  assert.match(warned, /Missing &lt;model&gt; access\./)
  assert.doesNotMatch(warned, /<model>/)
})
