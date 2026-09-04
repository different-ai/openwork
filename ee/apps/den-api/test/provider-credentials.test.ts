import { describe, expect, test } from "bun:test"

import {
  ProviderCredentialError,
  decodeProviderCredential,
  listConfiguredEnvKeys,
  readProviderEnvNames,
  resolveProviderCredential,
  runtimeProviderEnvName,
  runtimeProviderEnvNames,
  runtimeProviderEnvTag,
  selectLegacyScalarCredentialEnvName,
  selectPrimaryCredentialEnvName,
  toRuntimeProviderEnv,
} from "../src/llm/provider-credentials.js"

const AWS_ENV = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_REGION",
  "AWS_BEARER_TOKEN_BEDROCK",
]

describe("readProviderEnvNames", () => {
  test("reads the env string list, dropping blanks and non-strings", () => {
    expect(readProviderEnvNames({ env: ["A", " ", 3, "B"] })).toEqual(["A", "B"])
    expect(readProviderEnvNames({})).toEqual([])
  })
})

describe("selectPrimaryCredentialEnvName", () => {
  test("prefers Azure API key over resource name", () => {
    expect(
      selectPrimaryCredentialEnvName(
        ["AZURE_RESOURCE_NAME", "AZURE_API_KEY"],
        ["AZURE_RESOURCE_NAME", "AZURE_API_KEY"],
      ),
    ).toBe("AZURE_API_KEY")
  })

  test("does not treat Azure resource name alone as the credential", () => {
    expect(
      selectPrimaryCredentialEnvName(
        ["AZURE_RESOURCE_NAME", "AZURE_API_KEY"],
        ["AZURE_RESOURCE_NAME"],
      ),
    ).toBeNull()
  })

  test("ignores API-shaped names that the provider did not declare", () => {
    expect(
      selectPrimaryCredentialEnvName(
        ["AZURE_RESOURCE_NAME", "AZURE_API_KEY"],
        ["OPENAI_API_KEY"],
      ),
    ).toBeNull()
  })

  test("keeps AWS access key as the primary credential", () => {
    expect(selectPrimaryCredentialEnvName(AWS_ENV, ["AWS_ACCESS_KEY_ID", "AWS_REGION"])).toBe("AWS_ACCESS_KEY_ID")
  })
})

describe("selectLegacyScalarCredentialEnvName", () => {
  test("maps legacy Azure scalar credentials to the declared API key env", () => {
    expect(selectLegacyScalarCredentialEnvName(["AZURE_RESOURCE_NAME", "AZURE_API_KEY"])).toBe("AZURE_API_KEY")
  })

  test("keeps legacy AWS scalar credentials on access key id", () => {
    expect(selectLegacyScalarCredentialEnvName(AWS_ENV)).toBe("AWS_ACCESS_KEY_ID")
  })
})

describe("decodeProviderCredential", () => {
  test("empty column decodes to no credential", () => {
    expect(decodeProviderCredential(null)).toEqual({ apiKey: null, apiKeys: null })
    expect(decodeProviderCredential("  ")).toEqual({ apiKey: null, apiKeys: null })
  })

  test("plain strings decode as the legacy single credential", () => {
    expect(decodeProviderCredential("sk-test")).toEqual({ apiKey: "sk-test", apiKeys: null })
  })

  test("a JSON object of string values decodes as a multi-env map", () => {
    const stored = JSON.stringify({ AWS_ACCESS_KEY_ID: "AKIA", AWS_REGION: "us-east-1" })
    expect(decodeProviderCredential(stored)).toEqual({
      apiKey: null,
      apiKeys: { AWS_ACCESS_KEY_ID: "AKIA", AWS_REGION: "us-east-1" },
    })
  })

  test("JSON-looking strings that are not string maps stay plain credentials", () => {
    for (const value of ['{"a": 1}', '{"a": {"b": "c"}}', "{}", "{not-json", "[1,2]"]) {
      expect(decodeProviderCredential(value)).toEqual({ apiKey: value, apiKeys: null })
    }
  })
})

describe("resolveProviderCredential", () => {
  test("single-env providers store the bare string (legacy format)", () => {
    expect(
      resolveProviderCredential({
        envNames: ["GATEWAY_API_KEY"],
        existing: null,
        apiKeys: { GATEWAY_API_KEY: " sk-live " },
      }),
    ).toBe("sk-live")
  })

  test("multi-env providers store a JSON map in env order", () => {
    const stored = resolveProviderCredential({
      envNames: AWS_ENV,
      existing: null,
      apiKeys: {
        AWS_REGION: "us-east-1",
        AWS_ACCESS_KEY_ID: "AKIA",
      },
    })
    expect(stored).toBe(JSON.stringify({ AWS_ACCESS_KEY_ID: "AKIA", AWS_REGION: "us-east-1" }))
  })

  test("blank apiKeys entries clear a stored value, absent entries keep it", () => {
    const existing = {
      value: JSON.stringify({ AWS_ACCESS_KEY_ID: "AKIA", AWS_REGION: "us-east-1" }),
      envNames: AWS_ENV,
    }
    const stored = resolveProviderCredential({
      envNames: AWS_ENV,
      existing,
      apiKeys: { AWS_REGION: "", AWS_SECRET_ACCESS_KEY: "shhh" },
    })
    expect(stored).toBe(
      JSON.stringify({ AWS_ACCESS_KEY_ID: "AKIA", AWS_SECRET_ACCESS_KEY: "shhh" }),
    )
  })

  test("rejects env keys the provider config does not declare", () => {
    expect(() =>
      resolveProviderCredential({
        envNames: ["GATEWAY_API_KEY"],
        existing: null,
        apiKeys: { OTHER_KEY: "x" },
      }),
    ).toThrow(ProviderCredentialError)
  })

  test("legacy apiKey input still replaces the whole credential", () => {
    expect(
      resolveProviderCredential({
        envNames: AWS_ENV,
        existing: { value: JSON.stringify({ AWS_REGION: "us-east-1" }), envNames: AWS_ENV },
        apiKey: "sk-replacement",
      }),
    ).toBe("sk-replacement")
    expect(
      resolveProviderCredential({
        envNames: ["GATEWAY_API_KEY"],
        existing: { value: "sk-old", envNames: ["GATEWAY_API_KEY"] },
        apiKey: "",
      }),
    ).toBeNull()
  })

  test("keeps the stored column verbatim when no credential input is given", () => {
    expect(
      resolveProviderCredential({
        envNames: AWS_ENV,
        existing: { value: "sk-legacy", envNames: ["GATEWAY_API_KEY"] },
      }),
    ).toBe("sk-legacy")
    expect(resolveProviderCredential({ envNames: [], existing: null })).toBeNull()
  })

  test("migrates a legacy single credential into the map when merging", () => {
    // Provider config went from one env key to several; the stored plain
    // string maps to the old env[0] and survives the merge.
    const stored = resolveProviderCredential({
      envNames: ["GATEWAY_API_KEY", "GATEWAY_REGION"],
      existing: { value: "sk-legacy", envNames: ["GATEWAY_API_KEY"] },
      apiKeys: { GATEWAY_REGION: "eu-west-1" },
    })
    expect(stored).toBe(
      JSON.stringify({ GATEWAY_API_KEY: "sk-legacy", GATEWAY_REGION: "eu-west-1" }),
    )
  })

  test("migrates a legacy Azure scalar credential into AZURE_API_KEY", () => {
    const stored = resolveProviderCredential({
      envNames: ["AZURE_RESOURCE_NAME", "AZURE_API_KEY"],
      existing: {
        value: "legacy-api-key",
        envNames: ["AZURE_RESOURCE_NAME", "AZURE_API_KEY"],
      },
      apiKeys: { AZURE_RESOURCE_NAME: "resource-name" },
    })

    expect(stored).toBe(
      JSON.stringify({ AZURE_RESOURCE_NAME: "resource-name", AZURE_API_KEY: "legacy-api-key" }),
    )
  })

  test("collapses a map back to a bare string when env shrinks to one key", () => {
    const stored = resolveProviderCredential({
      envNames: ["GATEWAY_API_KEY"],
      existing: {
        value: JSON.stringify({ GATEWAY_API_KEY: "sk-live", GATEWAY_REGION: "eu-west-1" }),
        envNames: ["GATEWAY_API_KEY", "GATEWAY_REGION"],
      },
      apiKeys: {},
    })
    expect(stored).toBe("sk-live")
  })

  test("returns null when every value is cleared", () => {
    expect(
      resolveProviderCredential({
        envNames: AWS_ENV,
        existing: { value: JSON.stringify({ AWS_REGION: "us-east-1" }), envNames: AWS_ENV },
        apiKeys: { AWS_REGION: "" },
      }),
    ).toBeNull()
  })
})

describe("listConfiguredEnvKeys", () => {
  test("multi-env maps list their keys in env order", () => {
    const stored = JSON.stringify({ AWS_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "AKIA" })
    expect(listConfiguredEnvKeys(stored, AWS_ENV)).toEqual([
      "AWS_ACCESS_KEY_ID",
      "AWS_REGION",
    ])
  })

  test("legacy plain credentials map to the primary credential env key", () => {
    expect(listConfiguredEnvKeys("sk-test", AWS_ENV)).toEqual(["AWS_ACCESS_KEY_ID"])
    expect(listConfiguredEnvKeys("sk-test", ["AZURE_RESOURCE_NAME", "AZURE_API_KEY"])).toEqual(["AZURE_API_KEY"])
    expect(listConfiguredEnvKeys("sk-test", [])).toEqual([])
    expect(listConfiguredEnvKeys(null, AWS_ENV)).toEqual([])
  })
})

describe("runtime provider env names", () => {
  const rowId = "lpr_01kx4t3amgendr682dmp6120jv"

  test("the tag is a pure function of the row id", () => {
    expect(runtimeProviderEnvTag(rowId)).toBe("LPR_120JV")
    expect(runtimeProviderEnvTag(rowId)).toBe(runtimeProviderEnvTag(rowId))
    expect(runtimeProviderEnvTag("lpr_01kx4t3apjendr685c2ryzevqe")).toBe("LPR_ZEVQE")
  })

  test("catalog providers get provider-scoped names that still rank as credentials", () => {
    const provider = { id: rowId, source: "models_dev", providerConfig: { env: ["AZURE_RESOURCE_NAME", "AZURE_API_KEY"] } }
    const names = runtimeProviderEnvNames(provider)
    expect(names).toEqual(["LPR_120JV_AZURE_RESOURCE_NAME", "LPR_120JV_AZURE_API_KEY"])
    expect(selectPrimaryCredentialEnvName(names, names)).toBe("LPR_120JV_AZURE_API_KEY")
  })

  test("custom and hosted providers keep exactly the names they declare", () => {
    const custom = { id: rowId, source: "custom", providerConfig: { env: ["LITELLM_API_KEY"] } }
    const hosted = { id: rowId, source: "openwork", providerConfig: { env: ["OPENWORK_API_KEY"] } }
    expect(runtimeProviderEnvNames(custom)).toEqual(["LITELLM_API_KEY"])
    expect(runtimeProviderEnvName(custom, "OPENAI_API_KEY")).toBe("OPENAI_API_KEY")
    expect(runtimeProviderEnvNames(hosted)).toEqual(["OPENWORK_API_KEY"])
    expect(toRuntimeProviderEnv({ ...custom, apiKeys: { LITELLM_API_KEY: "k" } })).toEqual({
      ...custom,
      apiKeys: { LITELLM_API_KEY: "k" },
    })
  })

  test("toRuntimeProviderEnv renames the block and the multi-env map together, never the stored input", () => {
    const stored = {
      id: rowId,
      source: "models_dev",
      providerConfig: { id: "azure", env: ["AZURE_RESOURCE_NAME", "AZURE_API_KEY"] },
      apiKeys: { AZURE_RESOURCE_NAME: "resource", AZURE_API_KEY: "secret" },
    }
    const runtime = toRuntimeProviderEnv(stored)
    expect(runtime.providerConfig).toEqual({ id: "azure", env: ["LPR_120JV_AZURE_RESOURCE_NAME", "LPR_120JV_AZURE_API_KEY"] })
    expect(runtime.apiKeys).toEqual({ LPR_120JV_AZURE_RESOURCE_NAME: "resource", LPR_120JV_AZURE_API_KEY: "secret" })
    expect(stored.providerConfig.env).toEqual(["AZURE_RESOURCE_NAME", "AZURE_API_KEY"])
    expect(Object.keys(stored.apiKeys)).toEqual(["AZURE_RESOURCE_NAME", "AZURE_API_KEY"])
  })

  test("a provider without a declared env list is returned untouched", () => {
    const provider = { id: rowId, source: "models_dev", providerConfig: { id: "x" }, apiKeys: null }
    expect(toRuntimeProviderEnv(provider)).toBe(provider)
  })
})
