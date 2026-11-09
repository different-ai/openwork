/**
 * Config blobs: the `env` secret allowlist (self-hosted operators,
 * DEN_CONFIG_BLOB_SECRET_ENV_ALLOWLIST), and the engine's secret-field and
 * array-layout path rules.
 */
import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { configSecretEnvAllowed, configSecretEnvPolicy, readConfigSecretEnv } from "../src/config-blobs/env-secrets.js"
import { canonicalJson, checkSecretFields, findSecrets, matchesSecretField, specRev } from "../src/config-blobs/engine/index.js"
import { arrayElementKey, isOrderedArray } from "../src/config-blobs/engine/util.js"

describe("env secret allowlist", () => {
  test("exact names and trailing-* prefixes match; nothing else does", () => {
    const allowlist = ["ANTHROPIC_KEY", "OPENWORK_IMPORT_*"]
    assert.equal(configSecretEnvAllowed("ANTHROPIC_KEY", allowlist), true)
    assert.equal(configSecretEnvAllowed("ANTHROPIC_KEY_2", allowlist), false)
    assert.equal(configSecretEnvAllowed("OPENWORK_IMPORT_OPENAI", allowlist), true)
    assert.equal(configSecretEnvAllowed("OPENWORK_IMPORT_", allowlist), true)
    assert.equal(configSecretEnvAllowed("OPENWORK_IMPORTED", allowlist), false)
    assert.equal(configSecretEnvAllowed("DATABASE_URL", allowlist), false)
  })

  test("a bare * or an inner * never matches, and invalid names are refused", () => {
    assert.equal(configSecretEnvAllowed("DATABASE_URL", ["*"]), false)
    assert.equal(configSecretEnvAllowed("A_B", ["A*B*"]), false)
    assert.equal(configSecretEnvAllowed("lowercase", ["lowercase"]), false)
    assert.equal(configSecretEnvAllowed("", [""]), false)
  })

  test("cloud and an empty allowlist allow nothing", () => {
    assert.equal(configSecretEnvPolicy("cloud", ["ANTHROPIC_KEY"])("ANTHROPIC_KEY"), false)
    assert.equal(configSecretEnvPolicy("self_hosted", [])("ANTHROPIC_KEY"), false)
    assert.equal(configSecretEnvPolicy("self_hosted", ["ANTHROPIC_KEY"])("ANTHROPIC_KEY"), true)
  })

  test("reads only allowed, set, non-empty variables", () => {
    const allowed = configSecretEnvPolicy("self_hosted", ["KEY_*"])
    const source = { KEY_A: "sk-a", KEY_EMPTY: "", OTHER: "sk-other" }
    assert.equal(readConfigSecretEnv("KEY_A", allowed, source), "sk-a")
    assert.equal(readConfigSecretEnv("KEY_EMPTY", allowed, source), null)
    assert.equal(readConfigSecretEnv("KEY_MISSING", allowed, source), null)
    assert.equal(readConfigSecretEnv("OTHER", allowed, source), null)
  })
})

describe("engine paths", () => {
  test("arrayKeys and orderedArrays take the documented array path (and the element path)", () => {
    const byArray = { arrayKeys: { models: "modelId" }, orderedArrays: ["fallback"] }
    const byElement = { arrayKeys: { "models[]": "modelId" }, orderedArrays: ["fallback[]"] }
    for (const layout of [byArray, byElement]) {
      assert.deepEqual(arrayElementKey(layout, "models[]", { modelId: "m1", id: "x" }), { field: "modelId", value: "m1" })
      assert.equal(isOrderedArray(layout, "fallback"), true)
      const a = { models: [{ modelId: "b" }, { modelId: "a" }], fallback: ["1", "2"] }
      const b = { models: [{ modelId: "a" }, { modelId: "b" }], fallback: ["1", "2"] }
      assert.equal(canonicalJson(layout, a), canonicalJson(layout, b))
      assert.notEqual(specRev(layout, a), specRev(layout, { ...b, fallback: ["2", "1"] }))
    }
  })

  test("secret fields with wildcard map keys and array elements", () => {
    assert.equal(matchesSecretField("credentials.apiKeys.*", "credentials.apiKeys.OPENAI_API_KEY"), true)
    assert.equal(matchesSecretField("credentials.apiKeys.*", "credentials.apiKeys"), false)
    assert.equal(matchesSecretField("credentials.apiKeys.*", "credentials.apiKeys.A.b"), false)
    assert.equal(matchesSecretField("requestHeaders[].value", "requestHeaders[].value"), true)
    assert.equal(matchesSecretField("credentials.apiKey", "credentials.apiKey"), true)

    const fields = ["credentials.apiKey", "credentials.apiKeys.*", "requestHeaders[].value"]
    const spec = {
      credentials: { apiKeys: { OPENAI_API_KEY: { $secret: "a/x/credentials.apiKeys.OPENAI_API_KEY", set: true }, AZURE_KEY: { $secret: "a/x/credentials.apiKeys.AZURE_KEY", set: false } } },
      requestHeaders: [{ name: "X", value: { $secret: "a/x/requestHeaders.X.value", set: true } }],
    }
    assert.deepEqual(checkSecretFields(fields, spec), { undeclared: [], raw: [] })
    const found = findSecrets({ arrayKeys: { requestHeaders: "name" } }, spec).map((entry) => entry.field).sort()
    assert.deepEqual(found, ["credentials.apiKeys.AZURE_KEY", "credentials.apiKeys.OPENAI_API_KEY", "requestHeaders[name=X].value"])

    const pasted = { credentials: { apiKeys: { OPENAI_API_KEY: "sk-pasted" } }, other: { $secret: "a/x/other", set: true } }
    assert.deepEqual(checkSecretFields(fields, pasted), { undeclared: ["other"], raw: ["credentials.apiKeys.OPENAI_API_KEY"] })
  })
})
