import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import {
  BEDROCK_MANTLE_NPM,
  BEDROCK_MANTLE_PROVIDER_ID,
  bedrockMantleApiPath,
  bedrockMantleApiPathsFromCatalog,
  deriveBedrockMantleProvider,
  withBedrockMantleProvider,
} from "./bedrock-mantle-catalog"
import { bedrockMantleHost } from "./inference-egress"

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const baseJson: unknown = JSON.parse(readFileSync(path.resolve(import.meta.dir, "../../../apps/gateway/src/models/base.json"), "utf8"))

test("the bundled catalog yields a separate Mantle provider with all 13 Mantle models and their API paths", () => {
  if (!isRecord(baseJson)) throw new Error("base.json must be an object")
  const derived = deriveBedrockMantleProvider(baseJson)
  if (!derived || !isRecord(derived.models)) throw new Error("expected a derived provider")
  expect(derived).toMatchObject({ id: BEDROCK_MANTLE_PROVIDER_ID, name: "Amazon Bedrock (OpenAI)", npm: BEDROCK_MANTLE_NPM, env: ["AWS_BEARER_TOKEN_BEDROCK"] })
  const ids = Object.keys(derived.models).sort()
  expect(ids).toEqual([
    "google.gemma-4-26b-a4b", "google.gemma-4-31b", "google.gemma-4-e2b",
    "openai.gpt-5.4", "openai.gpt-5.5", "openai.gpt-5.6-luna", "openai.gpt-5.6-sol", "openai.gpt-5.6-terra",
    "openai.gpt-6-astra", "openai.gpt-oss-120b", "openai.gpt-oss-20b", "xai.grok-4.3", "xai.grok-4.6",
  ])
  // The per-model endpoint template never reaches Den or the desktop; pricing and metadata survive.
  for (const model of Object.values(derived.models)) {
    if (!isRecord(model) || !isRecord(model.provider)) throw new Error("expected model provider")
    expect(model.provider.api).toBeUndefined()
    expect(model.provider.npm).toBe(BEDROCK_MANTLE_NPM)
    expect(JSON.stringify(model)).not.toContain("${")
    expect(isRecord(model.cost)).toBe(true)
  }
  const paths = bedrockMantleApiPathsFromCatalog(baseJson)
  expect(paths.size).toBe(13)
  expect(paths.get("openai.gpt-oss-20b")).toBe("/v1")
  expect(paths.get("openai.gpt-oss-120b")).toBe("/v1")
  expect(paths.get("openai.gpt-5.5")).toBe("/openai/v1")
  expect(paths.get("xai.grok-4.6")).toBe("/openai/v1")
  // The source provider is not modified.
  expect(withBedrockMantleProvider(baseJson)["amazon-bedrock"]).toBe(baseJson["amazon-bedrock"])
})

test("a real upstream amazon-bedrock-mantle entry wins over the derivation", () => {
  const upstream = { id: BEDROCK_MANTLE_PROVIDER_ID, name: "Upstream", npm: BEDROCK_MANTLE_NPM, env: [], models: { a: { id: "a", provider: { npm: BEDROCK_MANTLE_NPM, api: "https://bedrock-mantle.${AWS_REGION}.api.aws/openai/v1" } } } }
  const catalog = {
    "amazon-bedrock": { models: { b: { id: "b", provider: { npm: BEDROCK_MANTLE_NPM, api: "https://bedrock-mantle.${AWS_REGION}.api.aws/v1" } } } },
    [BEDROCK_MANTLE_PROVIDER_ID]: upstream,
  }
  expect(withBedrockMantleProvider(catalog)[BEDROCK_MANTLE_PROVIDER_ID]).toBe(upstream)
  expect([...bedrockMantleApiPathsFromCatalog(catalog)]).toEqual([["a", "/openai/v1"]])
})

test("no Mantle models means no derived provider", () => {
  const catalog = { "amazon-bedrock": { models: { c: { id: "c" } } } }
  expect(deriveBedrockMantleProvider(catalog)).toBeNull()
  expect(withBedrockMantleProvider(catalog)).toBe(catalog)
  expect(deriveBedrockMantleProvider({})).toBeNull()
})

test("Mantle API paths accept only the Mantle host shape and known paths; hosts come from a validated region", () => {
  expect(bedrockMantleApiPath("https://bedrock-mantle.${AWS_REGION}.api.aws/openai/v1")).toBe("/openai/v1")
  expect(bedrockMantleApiPath("https://bedrock-mantle.us-west-2.api.aws/v1/")).toBe("/v1")
  for (const api of ["https://evil.test/v1", "https://bedrock-mantle.${AWS_REGION}.api.aws.evil.test/v1", "https://bedrock-mantle.${AWS_REGION}.api.aws/admin", "http://bedrock-mantle.us-east-1.api.aws/v1", null]) {
    expect(bedrockMantleApiPath(api)).toBeNull()
  }
  expect(bedrockMantleHost("eu-west-1")).toBe("bedrock-mantle.eu-west-1.api.aws")
  expect(() => bedrockMantleHost("eu-west-1.evil.test")).toThrow()
})
