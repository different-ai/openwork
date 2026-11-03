import assert from "node:assert/strict"
import { test } from "node:test"
import { verifyProviderTestSignature } from "@openwork-ee/utils/provider-test-signature"
import { requestGatewayProviderTest } from "../src/llm/gateway-provider-test.js"

const gateway = { baseUrl: "http://gateway.test/", key: "ow_gw_fixture", signingSecret: "fixture-shared-secret-0000000000000000", organizationId: "org_fixture", memberId: "om_fixture" }

const input = { providerId: "anthropic", model: "claude-sonnet-5", settings: {}, credential: { kind: "api_key", secret: "sk-ant-fixture-key-000000" } }

test("Den forwards the unsaved configuration to the gateway with the member's gateway key", async () => {
  const sent: Array<{ url: string; authorization: string | null; body: unknown; signed: boolean }> = []
  const result = await requestGatewayProviderTest(input, { ...gateway, fetch: async (url, init) => {
    const request = new Request(url, init)
    const text = await request.text()
    const signed = verifyProviderTestSignature(gateway.signingSecret, { organizationId: gateway.organizationId, memberId: gateway.memberId, body: text }, request.headers.get("x-openwork-provider-test-signature") ?? "")
    sent.push({ url: request.url, authorization: request.headers.get("authorization"), body: JSON.parse(text), signed })
    return Response.json({ ok: true, model: "claude-sonnet-5", status: 200, code: null, message: null })
  } })
  assert.deepEqual(result, { ok: true, model: "claude-sonnet-5", status: 200, code: null, message: null })
  assert.equal(sent[0]?.url, "http://gateway.test/api/v1/provider-tests")
  assert.equal(sent[0]?.authorization, "Bearer ow_gw_fixture")
  assert.deepEqual(sent[0]?.body, input)
  assert.equal(sent[0]?.signed, true)
})

test("a provider failure from the gateway is passed through", async () => {
  const result = await requestGatewayProviderTest(input, { ...gateway, fetch: async () => Response.json({ ok: false, model: "claude-sonnet-5", status: 401, code: "provider_authentication_failed", message: "The provider rejected this key." }) })
  assert.deepEqual(result, { ok: false, model: "claude-sonnet-5", status: 401, code: "provider_authentication_failed", message: "The provider rejected this key." })
})

test("an unreachable gateway or a malformed answer is a failed test, never a pass", async () => {
  const down = await requestGatewayProviderTest(input, { ...gateway, fetch: async () => { throw new TypeError("fetch failed") } })
  assert.equal(down.ok, false)
  assert.equal(down.code, "gateway_unreachable")
  const refused = await requestGatewayProviderTest(input, { ...gateway, fetch: async () => Response.json({ error: "invalid_api_key" }, { status: 401 }) })
  assert.equal(refused.code, "gateway_unreachable")
  const malformed = await requestGatewayProviderTest(input, { ...gateway, fetch: async () => Response.json({ ok: true }) })
  assert.equal(malformed.ok, false)
})
