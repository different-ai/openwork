import assert from "node:assert/strict"
import { test } from "node:test"
import { applyBedrockGuardrail, hasClientBedrockGuardrail } from "../src/bedrock-guardrail.js"
import { signAwsRequest } from "../src/aws-sigv4.js"

const settings = { guardrailIdentifier: "abc123def456", guardrailVersion: "1" }
const body = '{ "messages": [] }'

for (const operation of ["converse", "converse-stream", "invoke", "invoke-with-response-stream"]) {
  test(`${operation} applies organization policy before the actual SigV4 signature`, () => {
    const url = new URL(`https://bedrock-runtime.us-east-1.amazonaws.com/model/amazon.nova-lite-v1%3A0/${operation}`)
    const headers = new Headers({ "content-type": "application/json" })
    const result = applyBedrockGuardrail({ enabled: true, family: "bedrock", settings, url, headers, body })
    assert.ok(!("error" in result))
    assert.equal(result.applied, true)
    signAwsRequest({ method: "POST", url, headers, body: result.body, credentials: { accessKeyId: "AKIAEXAMPLE0000000000", secretAccessKey: "example-secret-key-for-unit-tests-only" }, region: "us-east-1", service: "bedrock", now: new Date("2026-11-25T00:00:00Z") })
    if (operation.startsWith("converse")) {
      assert.equal(typeof result.body, "string")
      const parsed: unknown = JSON.parse(String(result.body))
      assert.ok(typeof parsed === "object" && parsed !== null)
      assert.deepEqual(Reflect.get(parsed, "guardrailConfig"), settings)
    } else {
      assert.equal(result.body, body)
      assert.equal(headers.get("x-amzn-bedrock-guardrailidentifier"), settings.guardrailIdentifier)
      assert.match(headers.get("authorization") ?? "", /SignedHeaders=[^,]*x-amzn-bedrock-guardrailidentifier;x-amzn-bedrock-guardrailversion/)
    }
    const withoutGuardrail = new Headers({ "content-type": "application/json" })
    signAwsRequest({ method: "POST", url, headers: withoutGuardrail, body, credentials: { accessKeyId: "AKIAEXAMPLE0000000000", secretAccessKey: "example-secret-key-for-unit-tests-only" }, region: "us-east-1", service: "bedrock", now: new Date("2026-11-25T00:00:00Z") })
    assert.notEqual(headers.get("authorization"), withoutGuardrail.get("authorization"))
  })
  for (const disabled of [true, false]) {
    test(`${operation} preserves exact bytes and headers with ${disabled ? "the flag off" : "no guardrail"}`, () => {
      const bytes = new TextEncoder().encode(body)
      const headers = new Headers({ "content-type": "application/json" })
      const before = [...headers]
      const result = applyBedrockGuardrail({ enabled: !disabled, family: "bedrock", settings: disabled ? settings : {}, url: new URL(`https://example.com/model/test/${operation}`), headers, body: bytes })
      assert.deepEqual(result, { applied: false, body: bytes })
      if (!("error" in result)) assert.equal(result.body, bytes)
      assert.deepEqual([...headers], before)
    })
  }
}

test("configured Mantle and unknown Runtime operations fail closed", () => {
  for (const family of ["bedrock", "bedrock_mantle"]) {
    const result = applyBedrockGuardrail({ enabled: true, family: family === "bedrock" ? "bedrock" : "bedrock_mantle", settings, url: new URL("https://example.com/chat/completions"), headers: new Headers(), body })
    assert.ok("error" in result)
  }
})

test("partial policy fails closed", () => {
  const result = applyBedrockGuardrail({ enabled: true, family: "bedrock", settings: { guardrailIdentifier: "abc123def456" }, url: new URL("https://example.com/model/test/converse"), headers: new Headers(), body })
  assert.ok("error" in result)
})

test("client policy and selective assessment fields cannot survive translation", () => {
  for (const field of ["guardrailConfig", "guardrail_identifier", "guardrailVersion", "guardContent", "amazon-bedrock-guardrailConfig"]) {
    assert.equal(hasClientBedrockGuardrail(new Headers(), { nested: [{ [field]: {} }] }), true)
  }
  for (const header of ["X-Amzn-Bedrock-GuardrailIdentifier", "X-Amzn-Bedrock-GuardrailVersion"]) assert.equal(hasClientBedrockGuardrail(new Headers({ [header]: "client-value" })), true)
  assert.equal(hasClientBedrockGuardrail(new Headers(), { messages: [{ content: "guardrailIdentifier is plain text" }] }), false)
  assert.equal(hasClientBedrockGuardrail(new Headers(), { tools: [{ type: "function", function: { name: "inspect_aws_policy", parameters: { type: "object", properties: { guardrailIdentifier: { type: "string" } } } } }] }), false)
  assert.equal(hasClientBedrockGuardrail(new Headers(), { messages: [{ content: [{ toolUse: { toolUseId: "call_fixture", name: "inspect_aws_policy", input: { guardrailIdentifier: "fixture" } } }] }] }), false)
  assert.equal(hasClientBedrockGuardrail(new Headers(), { messages: [{ content: [{ type: "tool_use", input: { guardrailIdentifier: "fixture" } }] }] }), false)
})
