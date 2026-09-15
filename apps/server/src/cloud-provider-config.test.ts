import { expect, test } from "bun:test";
import { buildProviderConfig } from "./cloud-provider-sync.js";

function configuration(providerConfig: Record<string, unknown>) {
  return buildProviderConfig({
    id: "lpr_fixture",
    providerId: "fixture",
    name: "Fixture",
    source: "custom",
    updatedAt: null,
    providerConfig,
    models: [{ id: "model", name: "Model", config: {} }],
    apiKey: null,
    apiKeys: null,
    memberCredentialState: null,
    declaredEnvNames: [],
    credentialStatus: null,
    authUrl: null,
  });
}

test("an empty allowlist stays explicit while an omitted allowlist stays unrestricted", () => {
  expect(configuration({ whitelist: [] }).whitelist).toEqual([]);
  expect(configuration({}).whitelist).toBeUndefined();
  expect(configuration({ whitelist: ["model"] }).whitelist).toEqual(["model"]);
});

test("an empty blocklist denies nothing and non-empty blocklists survive materialization", () => {
  expect(configuration({ blacklist: [] }).blacklist ?? []).toEqual([]);
  expect(configuration({ blacklist: ["model"] }).blacklist).toEqual(["model"]);
  expect(configuration({ whitelist: [], blacklist: ["model"] })).toMatchObject({ whitelist: [], blacklist: ["model"] });
});
