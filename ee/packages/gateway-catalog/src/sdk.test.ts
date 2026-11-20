import assert from "node:assert/strict"
import test from "node:test"
import { GATEWAY_SDK_FAMILIES, SUPPORTED_GATEWAY_NPM_PACKAGES, gatewaySdkDefaultBaseUrl, gatewaySdkFamily, isSupportedGatewayNpm } from "./sdk.js"

test("every supported SDK package has a protocol family, and nothing else is supported", () => {
  assert.deepEqual([...SUPPORTED_GATEWAY_NPM_PACKAGES], Object.keys(GATEWAY_SDK_FAMILIES))
  for (const npm of SUPPORTED_GATEWAY_NPM_PACKAGES) assert.ok(gatewaySdkFamily(npm))
  for (const npm of [null, undefined, "", "@ai-sdk/cohere", "toString", "constructor"]) {
    assert.equal(isSupportedGatewayNpm(npm), false)
    assert.equal(gatewaySdkFamily(npm), null)
  }
})

test("only SDKs with a fixed public endpoint have a default upstream", () => {
  assert.equal(gatewaySdkDefaultBaseUrl("@ai-sdk/anthropic"), "https://api.anthropic.com/v1")
  assert.equal(gatewaySdkDefaultBaseUrl("@ai-sdk/openai"), "https://api.openai.com/v1")
  assert.equal(gatewaySdkDefaultBaseUrl("@ai-sdk/mistral"), "https://api.mistral.ai/v1")
  assert.equal(gatewaySdkDefaultBaseUrl("@ai-sdk/google"), "https://generativelanguage.googleapis.com/v1beta")
  for (const npm of ["@ai-sdk/azure", "@ai-sdk/openai-compatible", "@openrouter/ai-sdk-provider", "@ai-sdk/google-vertex", "@ai-sdk/google-vertex/anthropic", "@ai-sdk/amazon-bedrock", "@ai-sdk/amazon-bedrock/mantle", "@ai-sdk/cohere", null]) {
    assert.equal(gatewaySdkDefaultBaseUrl(npm), null, String(npm))
  }
})
