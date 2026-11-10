/**
 * Config blobs: the `env` secret allowlist (self-hosted operators,
 * DEN_CONFIG_BLOB_SECRET_ENV_ALLOWLIST), and the engine's secret-field and
 * array-layout path rules.
 */
import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  configSecretEnvAllowed,
  configSecretEnvEntryProblem,
  configSecretEnvPolicy,
  isReservedEnvName,
  partitionConfigSecretEnvAllowlist,
  readConfigSecretEnv,
} from "../src/config-blobs/env-secrets.js"
import { canonicalJson, checkSecretFields, findSecrets, matchesSecretField, specRev } from "../src/config-blobs/engine/index.js"
import { arrayElementKey, isOrderedArray } from "../src/config-blobs/engine/util.js"

describe("env secret allowlist", () => {
  test("exact names and trailing-* prefixes inside OPENWORK_IMPORT_ match; nothing else does", () => {
    const allowlist = ["OPENWORK_IMPORT_ANTHROPIC_KEY", "OPENWORK_IMPORT_TEAM_*"]
    assert.equal(configSecretEnvAllowed("OPENWORK_IMPORT_ANTHROPIC_KEY", allowlist), true)
    assert.equal(configSecretEnvAllowed("OPENWORK_IMPORT_ANTHROPIC_KEY_2", allowlist), false)
    assert.equal(configSecretEnvAllowed("OPENWORK_IMPORT_TEAM_OPENAI", allowlist), true)
    assert.equal(configSecretEnvAllowed("OPENWORK_IMPORT_OTHER", allowlist), false)
    assert.equal(configSecretEnvAllowed("OPENWORK_IMPORT_", ["OPENWORK_IMPORT_*"]), false)
    assert.equal(configSecretEnvAllowed("OPENWORK_IMPORTED", ["OPENWORK_IMPORT_*"]), false)
    assert.equal(configSecretEnvAllowed("DATABASE_URL", allowlist), false)
  })

  test("a bare * or an inner * never matches, and invalid names are refused", () => {
    assert.equal(configSecretEnvAllowed("DATABASE_URL", ["*"]), false)
    assert.equal(configSecretEnvAllowed("OPENWORK_IMPORT_A_B", ["OPENWORK_IMPORT_A*B*"]), false)
    assert.equal(configSecretEnvAllowed("lowercase", ["lowercase"]), false)
    assert.equal(configSecretEnvAllowed("", [""]), false)
  })

  test("prefixes and names outside the namespace never reach Den API's own variables", () => {
    for (const name of ["DATABASE_URL", "DEN_DB_ENCRYPTION_KEY", "BETTER_AUTH_SECRET", "DEN_DIAGNOSTICS_BEARER_TOKEN", "STRIPE_SECRET_KEY", "ANTHROPIC_KEY"]) {
      for (const entry of ["D*", "B*", "S*", "A*", "OPENWORK_*", "O*", name]) {
        assert.equal(configSecretEnvAllowed(name, [entry]), false, `${entry} must not allow ${name}`)
      }
    }
    assert.equal(configSecretEnvEntryProblem("D*"), "prefixes must start with OPENWORK_IMPORT_")
    assert.equal(configSecretEnvEntryProblem("OPENWORK_*"), "prefixes must start with OPENWORK_IMPORT_")
    assert.equal(configSecretEnvEntryProblem("DATABASE_URL"), "names must start with OPENWORK_IMPORT_")
    assert.equal(configSecretEnvEntryProblem("OPENWORK_IMPORT_*"), null)
    assert.equal(isReservedEnvName("DEN_DB_ENCRYPTION_KEY"), true)
    assert.equal(isReservedEnvName("DATABASE_PASSWORD"), true)
    assert.equal(isReservedEnvName("OPENWORK_IMPORT_OIDC_CLIENT_SECRET"), false)
    assert.deepEqual(partitionConfigSecretEnvAllowlist(["OPENWORK_IMPORT_*", "D*", " OPENWORK_IMPORT_X "]), {
      allowed: ["OPENWORK_IMPORT_*", "OPENWORK_IMPORT_X"],
      ignored: [{ entry: "D*", problem: "prefixes must start with OPENWORK_IMPORT_" }],
    })
  })

  test("cloud and an empty allowlist allow nothing", () => {
    assert.equal(configSecretEnvPolicy("cloud", ["OPENWORK_IMPORT_KEY"])("OPENWORK_IMPORT_KEY"), false)
    assert.equal(configSecretEnvPolicy("self_hosted", [])("OPENWORK_IMPORT_KEY"), false)
    assert.equal(configSecretEnvPolicy("self_hosted", ["OPENWORK_IMPORT_KEY"])("OPENWORK_IMPORT_KEY"), true)
  })

  test("reads only allowed, set, non-empty variables", () => {
    const allowed = configSecretEnvPolicy("self_hosted", ["OPENWORK_IMPORT_*"])
    const source = { OPENWORK_IMPORT_A: "sk-a", OPENWORK_IMPORT_EMPTY: "", OTHER: "sk-other", DATABASE_URL: "mysql://x" }
    assert.equal(readConfigSecretEnv("OPENWORK_IMPORT_A", allowed, source), "sk-a")
    assert.equal(readConfigSecretEnv("OPENWORK_IMPORT_EMPTY", allowed, source), null)
    assert.equal(readConfigSecretEnv("OPENWORK_IMPORT_MISSING", allowed, source), null)
    assert.equal(readConfigSecretEnv("OTHER", allowed, source), null)
    // Even a caller-supplied policy that allows everything can't read outside the namespace.
    assert.equal(readConfigSecretEnv("DATABASE_URL", () => true, source), null)
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
