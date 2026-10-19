import assert from "node:assert/strict"
import { test } from "node:test"
import { bedrockCredentialError, toRuntimeProviderEnv } from "../src/llm/provider-credentials.ts"

const bedrockNpm = "@ai-sdk/amazon-bedrock"
const bedrockEnv = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION", "AWS_BEARER_TOKEN_BEDROCK"]
// The models.dev Bedrock entry as Den stores it.
const bedrock: Record<string, unknown> = { npm: bedrockNpm, env: bedrockEnv }
const rowId = "lpr_01kx00000000000000000keys1"

test("a catalog Bedrock row binds each delivered scoped name to its SDK option", () => {
  const runtime = toRuntimeProviderEnv({
    id: rowId,
    source: "models_dev",
    providerConfig: bedrock,
    apiKeys: { AWS_ACCESS_KEY_ID: "AKID", AWS_SECRET_ACCESS_KEY: "secret", AWS_REGION: "eu-central-2" },
  })
  assert.deepEqual(runtime.providerConfig.env, bedrockEnv.map((name) => `LPR_KEYS1_${name}`))
  // The bearer token has no value, so the SDK keeps its own fallback for it.
  assert.deepEqual(runtime.providerConfig.options, {
    accessKeyId: "{env:LPR_KEYS1_AWS_ACCESS_KEY_ID}",
    secretAccessKey: "{env:LPR_KEYS1_AWS_SECRET_ACCESS_KEY}",
    region: "{env:LPR_KEYS1_AWS_REGION}",
  })
  assert.deepEqual(Object.keys(runtime.apiKeys ?? {}), ["LPR_KEYS1_AWS_ACCESS_KEY_ID", "LPR_KEYS1_AWS_SECRET_ACCESS_KEY", "LPR_KEYS1_AWS_REGION"])
})

test("an option the provider sets explicitly keeps precedence", () => {
  const runtime = toRuntimeProviderEnv({
    id: rowId,
    source: "models_dev",
    providerConfig: { ...bedrock, options: { region: "us-west-2" } },
    apiKeys: { AWS_BEARER_TOKEN_BEDROCK: "token", AWS_REGION: "eu-central-2" },
  })
  assert.deepEqual(runtime.providerConfig.options, { apiKey: "{env:LPR_KEYS1_AWS_BEARER_TOKEN_BEDROCK}", region: "us-west-2" })
})

test("single-env and custom providers are left as they were", () => {
  // OpenCode already hands a single env value to the SDK as apiKey.
  const openai: Record<string, unknown> = { npm: "@ai-sdk/openai", env: ["OPENAI_API_KEY"] }
  const single = toRuntimeProviderEnv({ id: rowId, source: "models_dev", providerConfig: openai, apiKeys: { OPENAI_API_KEY: "sk" } })
  assert.equal(single.providerConfig.options, undefined)
  // Custom providers keep their declared names, which the SDK reads itself.
  const custom = { id: rowId, source: "custom", providerConfig: bedrock, apiKeys: { AWS_REGION: "eu-central-2" } }
  assert.equal(toRuntimeProviderEnv(custom), custom)
})

test("saving a Bedrock credential requires a valid AWS_REGION", () => {
  const credential = (values: Record<string, string>) => JSON.stringify(values)
  assert.equal(bedrockCredentialError(bedrock, credential({ AWS_BEARER_TOKEN_BEDROCK: "token", AWS_REGION: "us-east-1" })), null)
  assert.match(bedrockCredentialError(bedrock, credential({ AWS_BEARER_TOKEN_BEDROCK: "token" })) ?? "", /AWS_REGION/)
  assert.match(bedrockCredentialError(bedrock, credential({ AWS_BEARER_TOKEN_BEDROCK: "token", AWS_REGION: "bedrock.evil.example" })) ?? "", /AWS_REGION/)
  // Nothing stored (a per-member provider's organization row) and other providers are not checked.
  assert.equal(bedrockCredentialError(bedrock, null), null)
  assert.equal(bedrockCredentialError({ npm: "@ai-sdk/openai", env: ["OPENAI_API_KEY"] }, "sk"), null)
})
