import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { approvedProviderEnvironmentNames, machineOwnedProviderIds, providerConfigFingerprint, resolveProviderConfigTemplates } from "../src/provider-config-templates.js";
import { mapRuntimeProvidersToV2Specs } from "../src/engine-v2-preview.js";

const directory = "/fixture/runtime";
const definition = (baseURL = "{env:PROVIDER_URL}") => ({
  npm: "@ai-sdk/openai-compatible", env: ["PROVIDER_API_KEY"],
  options: { baseURL, apiKey: "{env:PROVIDER_API_KEY}", headers: { "x-region": "prefix-{env:REGION}" } },
  models: { model: { name: "Model" } },
});
const environment = new Map([["PROVIDER_URL", "http://127.0.0.1:8089/v1"], ["PROVIDER_API_KEY", "synthetic-provider-key"], ["REGION", "west"]]);
const options = { directory, environment, inheritedEnvironment: {}, localProviderIds: new Set(["local", "missing", "good"]),
  remoteEnvironmentNames: new Map([["remote", new Set(environment.keys())]]), realPath: async (path: string) => path };

test("resolves provider strings before native mapping without forwarding unrelated environment values", async () => {
  const source = { local: definition() };
  const result = await resolveProviderConfigTemplates(source, { ...options, inheritedEnvironment: { UNRELATED_SECRET: "must-stay-private" } });
  assert.deepEqual(result.errors, []);
  const mapped = mapRuntimeProvidersToV2Specs(result.providers, environment, new Map(), new Set(["local"]));
  assert.deepEqual(mapped.skippedProviderIds, []);
  assert.equal(mapped.specs[0]?.baseUrl, "http://127.0.0.1:8089/v1");
  assert.equal(mapped.specs[0]?.apiKey, "synthetic-provider-key");
  assert.deepEqual(mapped.specs[0]?.headers, { "x-region": "prefix-west" });
  assert.ok(!JSON.stringify(result).includes("must-stay-private"));
  assert.equal(source.local.options.baseURL, "{env:PROVIDER_URL}");
});

test("inherits applied desktop environment precedence over the stored Settings value", async () => {
  const result = await resolveProviderConfigTemplates({ local: definition() }, {
    ...options, inheritedEnvironment: { PROVIDER_URL: "https://inherited.example.test/v1", PROVIDER_API_KEY: "inherited-key" },
  });
  const mapped = mapRuntimeProvidersToV2Specs(result.providers);
  assert.equal(mapped.specs[0]?.baseUrl, "https://inherited.example.test/v1");
  assert.equal(mapped.specs[0]?.apiKey, "inherited-key");
});

test("missing and empty variables give a provider-specific error without disabling other providers", async () => {
  const result = await resolveProviderConfigTemplates({ missing: definition(), good: { models: {} } }, {
    ...options, inheritedEnvironment: { PROVIDER_URL: "" },
  });
  assert.deepEqual(Object.keys(result.providers), ["good"]);
  assert.deepEqual(result.errors.map(e => [e.providerId, e.field, e.code]), [["missing", "options.baseURL", "missing_environment_variable"]]);
  assert.match(result.errors[0]?.message ?? "", /PROVIDER_URL.*Settings > Environment/);
  assert.ok(!JSON.stringify(result.errors).includes("synthetic-provider-key"));
});

test("resolves api, nested options, model fields and array strings with V1 syntax", async () => {
  const result = await resolveProviderConfigTemplates({ local: {
    ...definition(), api: "{env:PROVIDER_URL}", models: { "{env:REGION}": { headers: { authorization: "Bearer {env:PROVIDER_API_KEY}" }, options: { regions: ["{env:REGION}"] } } },
  } }, options);
  assert.deepEqual(result.errors, []);
  const provider = result.providers.local;
  assert.ok(provider && typeof provider === "object" && "api" in provider);
  assert.equal(provider.api, "http://127.0.0.1:8089/v1");
  assert.ok(JSON.stringify(provider).includes('"regions":["west"]'));
  assert.ok(JSON.stringify(provider).includes('"west":{"headers"'));
});

test("local file references stay inside the config directory and preserve trimmed literal contents", async () => {
  const paths: string[] = [];
  const secret = 'quoted-"key\\value\n{env:NOT_EXPANDED}';
  const result = await resolveProviderConfigTemplates({ local: { options: {
    baseURL: "{file:./endpoint}", apiKey: "{file:/fixture/runtime/key}",
  } } }, { ...options, readText: async path => { paths.push(path); return path.endsWith("endpoint") ? " https://proxy.example.test/v1\n" : `  ${secret}  `; } });
  assert.deepEqual(paths.sort(), ["/fixture/runtime/endpoint", "/fixture/runtime/key"]);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.providers, { local: { options: { baseURL: "https://proxy.example.test/v1", apiKey: secret } } });
});

test("env expands before file references and unreadable files never expose substituted paths or OS errors", async () => {
  const result = await resolveProviderConfigTemplates({ local: { options: { apiKey: "{file:{env:PRIVATE_PATH}}" } } }, {
    ...options, environment: new Map([["PRIVATE_PATH", "/fixture/runtime/secret-bearing-path"]]), readText: async () => { throw new Error("sensitive OS error"); },
  });
  assert.deepEqual(result.providers, {});
  assert.equal(result.errors[0]?.code, "unreadable_file_reference");
  assert.ok(!JSON.stringify(result).includes("secret-bearing-path"));
  assert.ok(!JSON.stringify(result).includes("sensitive OS error"));
});

test("the server-only encryption key cannot be expanded into a provider", async () => {
  const result = await resolveProviderConfigTemplates({ local: { options: { apiKey: "{env:OPENWORK_ENCRYPTION_KEY}" } } }, {
    ...options, inheritedEnvironment: { OPENWORK_ENCRYPTION_KEY: "server-only" },
  });
  assert.deepEqual(result.providers, {});
  assert.equal(result.errors[0]?.code, "missing_environment_variable");
  assert.ok(!JSON.stringify(result).includes("server-only"));
});

test("remote providers cannot read process secrets even when the variable exists in the server", async () => {
  const result = await resolveProviderConfigTemplates({ remote: { options: {
    baseURL: "https://untrusted.example.test/{env:PROCESS_ONLY_SECRET}",
  } } }, { ...options, inheritedEnvironment: { PROCESS_ONLY_SECRET: "never-export-this" } });
  assert.deepEqual(result.providers, {});
  assert.equal(result.errors[0]?.code, "disallowed_environment_variable");
  assert.ok(!JSON.stringify(result).includes("never-export-this"));
});

test("remote variables resolve only from the stored user values and never fall back to process values", async () => {
  const result = await resolveProviderConfigTemplates({ remote: definition() }, {
    ...options, inheritedEnvironment: { PROVIDER_URL: "https://process.example.test", PROVIDER_API_KEY: "process-private" },
  });
  assert.deepEqual(result.errors, []);
  assert.equal(mapRuntimeProvidersToV2Specs(result.providers).specs[0]?.baseUrl, environment.get("PROVIDER_URL"));
  assert.equal(mapRuntimeProvidersToV2Specs(result.providers).specs[0]?.apiKey, environment.get("PROVIDER_API_KEY"));
  assert.ok(!JSON.stringify(result).includes("process-private"));
});

test("remote providers cannot resolve the server encryption key even from a malformed store", async () => {
  const result = await resolveProviderConfigTemplates({ remote: { options: { apiKey: "{env:OPENWORK_ENCRYPTION_KEY}" } } }, {
    ...options, environment: new Map([["OPENWORK_ENCRYPTION_KEY", "never-export-this"]]), inheritedEnvironment: { OPENWORK_ENCRYPTION_KEY: "also-private" },
    remoteEnvironmentNames: new Map([["remote", new Set(["OPENWORK_ENCRYPTION_KEY"])]]),
  });
  assert.deepEqual(result.providers, {});
  assert.equal(result.errors[0]?.code, "missing_environment_variable");
  assert.ok(!JSON.stringify(result).includes("never-export-this"));
  assert.ok(!JSON.stringify(result).includes("also-private"));
});

for (const reference of ["~/.ssh/id_rsa", "/etc/passwd", "./key", "../key"]) {
  test("remote providers cannot read any file reference: " + reference, async () => {
    let reads = 0;
    const result = await resolveProviderConfigTemplates({ remote: { options: { apiKey: `{file:${reference}}` } } }, {
      ...options, readText: async () => { reads++; return "host-private-key"; },
    });
    assert.deepEqual(result.providers, {});
    assert.equal(result.errors[0]?.code, "disallowed_file_reference");
    assert.equal(reads, 0);
    assert.ok(!JSON.stringify(result).includes("host-private-key"));
  });
}

for (const reference of ["../key", "nested/../../key", "nested\\..\\key", "/etc/passwd", "~/.ssh/id_rsa"]) {
  test("local file references cannot escape the declaring directory: " + reference, async () => {
    let reads = 0;
    const result = await resolveProviderConfigTemplates({ local: { options: { apiKey: `{file:${reference}}` } } }, {
      ...options, home: "/fixture/home", readText: async () => { reads++; return "host-private-key"; },
    });
    assert.deepEqual(result.providers, {});
    assert.equal(result.errors[0]?.code, "disallowed_file_reference");
    assert.equal(reads, 0);
  });
}

test("local symlink targets outside the configuration directory are not read", async () => {
  let reads = 0;
  const result = await resolveProviderConfigTemplates({ local: { options: { apiKey: "{file:linked-key}" } } }, {
    ...options, realPath: async path => path.endsWith("linked-key") ? "/private/outside-key" : directory,
    readText: async () => { reads++; return "host-private-key"; },
  });
  assert.deepEqual(result.providers, {});
  assert.equal(result.errors[0]?.code, "disallowed_file_reference");
  assert.equal(reads, 0);
});

test("a remote definition cannot authorize itself to read an unrelated stored secret", async () => {
  const result = await resolveProviderConfigTemplates({ remote: { env: ["OTHER_PROVIDER_API_KEY"], options: {
    baseURL: "https://untrusted.example.test/{env:OTHER_PROVIDER_API_KEY}",
  } } }, { ...options, environment: new Map([...environment, ["OTHER_PROVIDER_API_KEY", "unrelated-private-key"]]) });
  assert.deepEqual(result.providers, {});
  assert.equal(result.errors[0]?.code, "disallowed_environment_variable");
  assert.ok(!JSON.stringify(result).includes("unrelated-private-key"));
});

test("remote bindings reject another provider's replacement of a shared env slot", async () => {
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const store = new Map([["SHARED_API_KEY", "second-provider-key"]]);
  const approved = approvedProviderEnvironmentNames({
    first: { SHARED_API_KEY: hash("first-provider-key") },
    second: { SHARED_API_KEY: hash("second-provider-key") },
  }, store);
  assert.equal(approved.get("first")?.size, 0);
  assert.deepEqual([...approved.get("second") ?? []], ["SHARED_API_KEY"]);
  const result = await resolveProviderConfigTemplates({ first: { options: { apiKey: "{env:SHARED_API_KEY}" } } }, {
    ...options, environment: store, remoteEnvironmentNames: approved,
  });
  assert.deepEqual(result.providers, {});
  assert.equal(result.errors[0]?.code, "disallowed_environment_variable");
  assert.ok(!JSON.stringify(result).includes("second-provider-key"));
});

test("a configured provider is not machine-owned merely because its ID is not managed", async () => {
  const providers = { collaborator: { source: "local", env: ["PROCESS_ONLY_SECRET"], options: { apiKey: "{env:PROCESS_ONLY_SECRET}" } } };
  const localProviderIds = machineOwnedProviderIds(providers, {});
  assert.equal(localProviderIds.size, 0);
  const result = await resolveProviderConfigTemplates(providers, { ...options, localProviderIds,
    inheritedEnvironment: { PROCESS_ONLY_SECRET: "machine-private-key" },
  });
  assert.deepEqual(result.providers, {});
  assert.equal(result.errors[0]?.code, "disallowed_environment_variable");
  assert.ok(!JSON.stringify(result).includes("machine-private-key"));
});

test("machine approval covers only the exact provider configuration", async () => {
  const original = definition();
  const ownership = { local: providerConfigFingerprint(original) };
  assert.deepEqual([...machineOwnedProviderIds({ local: original }, ownership)], ["local"]);
  const changed = { ...original, options: { ...original.options, baseURL: "https://untrusted.example.test/{env:PROCESS_ONLY_SECRET}" } };
  const localProviderIds = machineOwnedProviderIds({ local: changed }, ownership);
  assert.equal(localProviderIds.size, 0);
  const result = await resolveProviderConfigTemplates({ local: changed }, { ...options, localProviderIds,
    inheritedEnvironment: { PROCESS_ONLY_SECRET: "machine-private-key" },
  });
  assert.deepEqual(result.providers, {});
  assert.ok(!JSON.stringify(result).includes("machine-private-key"));
});

test("unsafe variable names are rejected without echoing their contents", async () => {
  const result = await resolveProviderConfigTemplates({ remote: { options: { apiKey: "{env:bad name}" } } }, options);
  assert.deepEqual(result.providers, {});
  assert.equal(result.errors[0]?.code, "invalid_environment_variable");
  assert.ok(!JSON.stringify(result.errors).includes("bad name"));
});

for (const url of ["file:///private/config", "https://user:password@proxy.example.test/v1", "not a URL"]) {
  test("resolved endpoints still pass through the native endpoint safety check: " + url.split(":")[0], async () => {
    const result = await resolveProviderConfigTemplates({ local: definition() }, { ...options, environment: new Map([...environment, ["PROVIDER_URL", url]]) });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(mapRuntimeProvidersToV2Specs(result.providers, environment, new Map(), new Set(["local"])).skippedProviderIds, ["local"]);
  });
}
