import assert from "node:assert/strict"
import test from "node:test"
import { TrueFoundryError, createTrueFoundryClient, normalizeTrueFoundryEndpoints, trueFoundryCatalogModels, trueFoundryTokenName, type TrueFoundryFetch } from "../src/llm/truefoundry.js"

type Call = { method: string; url: string; authorization: string | null; body: unknown }

/** A scripted TrueFoundry: answers by "METHOD path" with a status and JSON body. */
function fakeTrueFoundry(routes: Record<string, (call: Call) => { status: number; body?: unknown }>) {
  const calls: Call[] = []
  const fetchImpl: TrueFoundryFetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url)
    const method = init?.method ?? "GET"
    const headers = new Headers(init?.headers)
    const call = { method, url: url.toString(), authorization: headers.get("authorization"), body: typeof init?.body === "string" ? JSON.parse(init.body) : null }
    calls.push(call)
    const handler = routes[`${method} ${url.pathname}`]
    const answer = handler ? handler(call) : { status: 404, body: { message: "not found" } }
    return new Response(answer.body === undefined ? "" : JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } })
  }
  return { calls, client: createTrueFoundryClient(normalizeTrueFoundryEndpoints("https://acme.truefoundry.cloud"), fetchImpl) }
}

test("TrueFoundry addresses: control plane root and default gateway", () => {
  assert.deepEqual(normalizeTrueFoundryEndpoints("https://acme.truefoundry.cloud/llm-gateway/playground"), {
    controlPlaneUrl: "https://acme.truefoundry.cloud",
    gatewayBaseUrl: "https://acme.truefoundry.cloud/api/llm",
  })
  assert.equal(normalizeTrueFoundryEndpoints("https://acme.truefoundry.cloud", "https://gateway.truefoundry.ai/chat/completions").gatewayBaseUrl, "https://gateway.truefoundry.ai")
  assert.equal(normalizeTrueFoundryEndpoints("https://acme.truefoundry.cloud/", "https://llm.acme.example/api/llm/").gatewayBaseUrl, "https://llm.acme.example/api/llm")
  for (const bad of ["not a url", "http://acme.truefoundry.cloud", "https://user:pw@acme.truefoundry.cloud", "https://acme.truefoundry.cloud/?q=1"]) {
    assert.throws(() => normalizeTrueFoundryEndpoints(bad), (error: unknown) => error instanceof TrueFoundryError && error.code === "invalid_url", bad)
  }
})

test("token names are valid TrueFoundry personal access token names", () => {
  for (let index = 0; index < 20; index += 1) assert.match(trueFoundryTokenName(), /^openwork-[a-z0-9-]{1,26}[a-z0-9]$/)
  assert.notEqual(trueFoundryTokenName(), trueFoundryTokenName())
})

test("listModels keeps chat models only, from the gateway with the given key", async () => {
  const { client, calls } = fakeTrueFoundry({
    "GET /api/llm/models": () => ({ status: 200, body: { object: "list", data: [
      { id: "openai/gpt-5.5", model_types: ["chat"] },
      { id: "openai/text-embedding-3", model_types: ["embedding"] },
      { id: "anthropic/claude", object: "model" },
      { id: "openai/gpt-5.5", model_types: ["chat"] },
    ] } }),
  })
  assert.deepEqual(await client.listModels("tfy_pat_member"), ["anthropic/claude", "openai/gpt-5.5"])
  assert.equal(calls[0].url, "https://acme.truefoundry.cloud/api/llm/models")
  assert.equal(calls[0].authorization, "Bearer tfy_pat_member")
})

test("requireAdmin refuses personal tokens and maps 401/403", async () => {
  const ok = fakeTrueFoundry({ "POST /api/svc/v1/users/register": (call) => {
    assert.deepEqual(call.body, { email: "openwork-admin-check@openwork.invalid", dryRun: true, skipIfUserExists: true })
    return { status: 201, body: {} }
  } })
  await ok.client.requireAdmin("tfy_va_admin")
  await assert.rejects(ok.client.requireAdmin("tfy_pat_someone"), (error: unknown) => error instanceof TrueFoundryError && error.code === "personal_token")
  assert.equal(ok.calls.length, 1, "a personal token is refused without calling TrueFoundry")
  const member = fakeTrueFoundry({ "POST /api/svc/v1/users/register": () => ({ status: 403, body: { message: "Forbidden" } }) })
  await assert.rejects(member.client.requireAdmin("tfy_va_member"), (error: unknown) => error instanceof TrueFoundryError && error.code === "not_admin")
  const bad = fakeTrueFoundry({ "POST /api/svc/v1/users/register": () => ({ status: 401, body: { message: "Invalid or expired token" } }) })
  await assert.rejects(bad.client.requireAdmin("nope"), (error: unknown) => error instanceof TrueFoundryError && error.code === "unauthorized")
})

test("findUserByEmail matches the whole email, case-insensitively", async () => {
  const { client, calls } = fakeTrueFoundry({ "GET /api/svc/v1/users": () => ({ status: 200, body: { data: [
    { id: "u1", email: "alice.smith@acme.com", active: true },
    { id: "u2", email: "Alice@acme.com", active: false },
  ], pagination: { total: 2 } } }) })
  assert.deepEqual(await client.findUserByEmail("tfy_va_admin", "ALICE@acme.com"), { id: "u2", email: "Alice@acme.com", active: false })
  assert.equal(new URL(calls[0].url).searchParams.get("query"), "alice@acme.com")
  assert.equal(await client.findUserByEmail("tfy_va_admin", "bob@acme.com"), null)
})

test("registerUser adds the person without an invite email", async () => {
  const { client, calls } = fakeTrueFoundry({ "POST /api/svc/v1/users/register": () => ({ status: 201, body: {} }) })
  await client.registerUser("tfy_va_admin", " new@acme.com ")
  assert.deepEqual(calls[0].body, { email: "new@acme.com", sendInviteEmail: false, skipIfUserExists: true })
})

test("createUserToken maps TrueFoundry's refusals", async () => {
  const created = fakeTrueFoundry({ "POST /api/svc/v1/personal-access-tokens/for-user": () => ({ status: 200, body: { token: "tfy_pat_new" } }) })
  assert.equal(await created.client.createUserToken("tfy_va_admin", { email: "a@acme.com", name: "openwork-abc" }), "tfy_pat_new")
  assert.deepEqual(created.calls[0].body, { name: "openwork-abc", userEmail: "a@acme.com" })
  const cases: Array<[number, string, string]> = [
    [404, "User with email a@acme.com not found", "user_not_found"],
    [400, "Maximum number of Personal Access Tokens reached: 3", "token_limit"],
    [403, "Forbidden", "not_admin"],
    [401, "Invalid or expired token", "unauthorized"],
  ]
  for (const [status, message, code] of cases) {
    const { client } = fakeTrueFoundry({ "POST /api/svc/v1/personal-access-tokens/for-user": () => ({ status, body: { statusCode: status, message } }) })
    await assert.rejects(client.createUserToken("tfy_va_admin", { email: "a@acme.com", name: "openwork-abc" }), (error: unknown) => error instanceof TrueFoundryError && error.code === code, code)
  }
})

test("a token finds and deletes itself; a token already gone counts as deleted", async () => {
  const { client, calls } = fakeTrueFoundry({
    "GET /api/svc/v1/personal-access-tokens": () => ({ status: 200, body: { data: [
      { id: "other", manifest: { name: "openwork-abcd" } },
      { id: "pat_1", manifest: { name: "openwork-abc" } },
    ] } }),
    "DELETE /api/svc/v1/personal-access-tokens/pat_1": () => ({ status: 200, body: {} }),
    "DELETE /api/svc/v1/personal-access-tokens/gone": () => ({ status: 401, body: { message: "Invalid or expired token" } }),
  })
  assert.equal(await client.ownTokenId("tfy_pat_new", "openwork-abc"), "pat_1")
  assert.equal(calls[0].authorization, "Bearer tfy_pat_new", "listed with the token itself, never the admin key")
  await client.deleteOwnToken("tfy_pat_new", "pat_1")
  await client.deleteOwnToken("tfy_pat_old", "gone")
  assert.equal(calls[1].authorization, "Bearer tfy_pat_new")
})

test("errors never echo keys or tokens", async () => {
  const { client } = fakeTrueFoundry({ "GET /api/llm/models": () => ({ status: 500, body: { message: "boom" } }) })
  await assert.rejects(client.listModels("tfy_pat_secret_value"), (error: unknown) => error instanceof TrueFoundryError && !error.message.includes("tfy_pat_secret_value"))
})

test("unmatched catalog models keep their id, declare tool calling and omit limits and prices", () => {
  assert.deepEqual(trueFoundryCatalogModels(["internal/house-model"]), [{ id: "internal/house-model", name: "internal/house-model", config: { id: "internal/house-model", name: "internal/house-model", tool_call: true, modalities: { input: ["text"], output: ["text"] } } }])
})
