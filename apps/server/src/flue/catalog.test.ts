import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Provider } from "@openwork/engine-protocol";
import {
  ENGINE_GLOBAL_RUNTIME_CONFIG_ID,
  readEffectiveRuntimeOpencodeConfig,
  writeRuntimeOpencodeConfig,
  type RuntimeOpencodeConfig,
} from "../runtime-opencode-config-store.js";
import type { ServerConfig } from "../types.js";
import {
  FlueCatalogBridge,
  apiKindForProvider,
  flueProviderListResponseSchema,
  materializeFlueCatalog,
  normalizeOpenWorkInferenceBaseUrl,
  parseFlueCatalogPayload,
  resetFlueCatalogCacheForTest,
  resolveProviderCredential,
  resolveProviderCredentialWithVault,
  type FlueCatalogMaterialization,
} from "./catalog.js";

const roots: string[] = [];
const WORKSPACE_ID = "ws_flue_catalog";

afterEach(async () => {
  resetFlueCatalogCacheForTest();
  while (roots.length) await rm(roots.pop() ?? "", { recursive: true, force: true });
});

function deterministicProvider(): Provider {
  return {
    id: "flue",
    name: "Flue",
    source: "custom",
    env: [],
    options: {},
    models: {
      default: {
        id: "default",
        providerID: "flue",
        api: { id: "faux", url: "http://localhost:0", npm: "@earendil-works/pi-ai" },
        name: "Flue deterministic model",
        family: "flue",
        capabilities: {
          temperature: false,
          reasoning: false,
          attachment: false,
          toolcall: true,
          input: { text: true, audio: false, image: false, video: false, pdf: false },
          output: { text: true, audio: false, image: false, video: false, pdf: false },
          interleaved: false,
        },
        cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        limit: { context: 128_000, output: 16_384 },
        status: "active",
        options: {},
        headers: {},
        release_date: "2026-07-29",
      },
    },
  };
}

function serverConfig(root: string): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    token: "token",
    hostToken: "host-token",
    configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 0 },
    corsOrigins: [],
    workspaces: [{ id: WORKSPACE_ID, name: "Test", path: root, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "generated",
    hostTokenSource: "generated",
    logFormat: "pretty",
    logRequests: false,
  };
}

async function withRuntimeWorkspace(fn: (input: { config: ServerConfig; workspaceId: string }) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "openwork-flue-runtime-config-"));
  roots.push(root);
  const previousDb = process.env.OPENWORK_RUNTIME_DB;
  process.env.OPENWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  try {
    await fn({ config: serverConfig(root), workspaceId: WORKSPACE_ID });
  } finally {
    if (previousDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
    else process.env.OPENWORK_RUNTIME_DB = previousDb;
  }
}

function catalogFixture(): Record<string, unknown> {
  return {
    openwork: {
      id: "openwork",
      name: "OpenWork Models",
      npm: "@openrouter/ai-sdk-provider",
      env: ["OPENWORK_API_KEY"],
      api: "https://inference.openworklabs.com/api/v1",
      models: {
        "moonshotai/kimi-k2.7-code": {
          name: "Kimi K2.7 Code",
          limit: { context: 262_144, output: 16_384 },
        },
        "z-ai/glm-5.2": {
          name: "GLM-5.2",
          limit: { context: 131_072, output: 8_192 },
        },
      },
    },
    anthropic: {
      id: "anthropic",
      name: "Anthropic",
      npm: "@ai-sdk/anthropic",
      env: ["ANTHROPIC_API_KEY"],
      api: "https://api.anthropic.com/v1",
      models: {
        "claude-sonnet-4-6": { name: "Claude Sonnet 4.6", limit: { context: 200_000, output: 32_000 } },
      },
    },
    openai: {
      id: "openai",
      name: "OpenAI",
      npm: "@ai-sdk/openai",
      env: ["OPENAI_API_KEY"],
      api: "https://api.openai.com/v1",
      models: {
        "gpt-5-nano": { name: "GPT-5 Nano", limit: { context: 400_000, output: 128_000 } },
      },
    },
    azure: {
      id: "azure",
      name: "Azure OpenAI",
      npm: "@ai-sdk/azure",
      env: ["AZURE_OPENAI_API_KEY"],
      api: "https://azure.example.test/openai",
      models: {
        "gpt-5-azure": { name: "GPT-5 Azure", limit: { context: 100_000, output: 16_000 } },
      },
    },
    bedrock: {
      id: "bedrock",
      name: "Amazon Bedrock",
      npm: "@ai-sdk/amazon-bedrock",
      env: ["AWS_ACCESS_KEY_ID"],
      api: "https://bedrock-runtime.us-east-1.amazonaws.com",
      models: {
        "anthropic.claude-sonnet-4": { name: "Bedrock Claude", limit: { context: 200_000, output: 16_000 } },
      },
    },
    compatible: {
      id: "compatible",
      name: "OpenAI Compatible",
      npm: "@ai-sdk/openai-compatible",
      env: ["COMPATIBLE_API_KEY"],
      api: "https://compatible.example.test/v1",
      models: {
        compat: { name: "Compat", limit: { context: 10_000, output: 1_000 } },
      },
    },
    malformed: {
      id: 7,
      name: "Malformed",
      models: [],
    },
  };
}

function credentialCatalogFixture(): Record<string, unknown> {
  return {
    store: {
      id: "store",
      name: "Store Provider",
      npm: "@ai-sdk/openai-compatible",
      env: ["SHARED_KEY"],
      api: "https://store.example.test/v1",
      models: { model: { name: "Store Model", limit: { context: 1_000, output: 100 } } },
    },
    process: {
      id: "process",
      name: "Process Provider",
      npm: "@ai-sdk/openai-compatible",
      env: ["PROCESS_KEY"],
      api: "https://process.example.test/v1",
      models: { model: { name: "Process Model", limit: { context: 1_000, output: 100 } } },
    },
    multi: {
      id: "multi",
      name: "Multi Provider",
      npm: "@ai-sdk/openai-compatible",
      env: ["MISSING_KEY", "SECOND_KEY"],
      api: "https://multi.example.test/v1",
      models: { model: { name: "Multi Model", limit: { context: 1_000, output: 100 } } },
    },
    none: {
      id: "none",
      name: "No Credential Provider",
      npm: "@ai-sdk/openai-compatible",
      env: ["NONE_KEY"],
      api: "https://none.example.test/v1",
      models: { model: { name: "No Credential Model", limit: { context: 1_000, output: 100 } } },
    },
    openwork: {
      id: "openwork",
      name: "OpenWork Models",
      npm: "@openrouter/ai-sdk-provider",
      env: ["OPENWORK_API_KEY"],
      api: "https://inference.openworklabs.com/api/v1",
      models: { "z-ai/glm-5.2": { name: "GLM-5.2", limit: { context: 1_000, output: 100 } } },
    },
  };
}

function registrationFor(materialization: FlueCatalogMaterialization, providerId: string) {
  return materialization.registrations.find((registration) => registration.providerId === providerId);
}

function providerIds(materialization: FlueCatalogMaterialization): string[] {
  return materialization.providerList.all.map((provider) => provider.id);
}

function expectProviderAbsent(materialization: FlueCatalogMaterialization, providerId: string): void {
  expect(registrationFor(materialization, providerId)).toBeUndefined();
  expect(providerIds(materialization)).not.toContain(providerId);
  expect(materialization.providerList.connected).not.toContain(providerId);
  expect(materialization.providerList.default[providerId]).toBeUndefined();
}

function jsonCatalogResponse(payload: unknown) {
  return {
    ok: true,
    status: 200,
    async json(): Promise<unknown> {
      return payload;
    },
  };
}

function timeoutCatalogFetch(_input: string, init?: RequestInit): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return;
    if (signal.aborted) {
      reject(new Error("timeout"));
      return;
    }
    signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true });
  });
}

describe("Flue catalog bridge", () => {
  test("maps catalog providers to exact Flue registerProvider arguments", () => {
    const parsed = parseFlueCatalogPayload(catalogFixture());
    const materialization = materializeFlueCatalog({
      catalogProviders: parsed.providers,
      catalogSkips: parsed.skipped,
      runtimeConfig: {},
      envStore: {
        OPENWORK_API_KEY: "ow-key",
        ANTHROPIC_API_KEY: "anthropic-key",
        OPENAI_API_KEY: "openai-key",
        AZURE_OPENAI_API_KEY: "azure-key",
        AWS_ACCESS_KEY_ID: "aws-key",
        COMPATIBLE_API_KEY: "compatible-key",
      },
      processEnv: {},
      deterministicProvider: deterministicProvider(),
    });

    expect(parsed.skipped).toEqual([{ providerId: "malformed", reason: "malformed" }]);
    expect(registrationFor(materialization, "openwork")?.registration).toEqual({
      api: "openai-completions",
      baseUrl: "https://inference.openworklabs.com/api/v1",
      apiKey: "ow-key",
      models: {
        "moonshotai/kimi-k2.7-code": { contextWindow: 262_144, maxTokens: 16_384 },
        "z-ai/glm-5.2": { contextWindow: 131_072, maxTokens: 8_192 },
      },
    });
    expect(registrationFor(materialization, "anthropic")?.registration.api).toBe("anthropic-messages");
    expect(registrationFor(materialization, "openai")?.registration.api).toBe("openai-responses");
    expect(registrationFor(materialization, "azure")?.registration.api).toBe("azure-openai-responses");
    expect(registrationFor(materialization, "bedrock")).toBeUndefined();
    expect(providerIds(materialization)).toContain("bedrock");
    expect(materialization.providerList.connected).not.toContain("bedrock");
    expect(materialization.skipped).toContainEqual({ providerId: "bedrock", reason: "unsupported_credential_scheme" });
    expect(registrationFor(materialization, "compatible")?.registration.api).toBe("openai-completions");
  });

  test("resolves credentials from env store first, then process env, across every env name", () => {
    const parsed = parseFlueCatalogPayload(credentialCatalogFixture());
    const materialization = materializeFlueCatalog({
      catalogProviders: parsed.providers,
      runtimeConfig: {},
      envStore: {
        SHARED_KEY: "store-secret",
        SECOND_KEY: "second-secret",
        OPENWORK_API_KEY: "openwork-secret",
        OPENWORK_INFERENCE_BASE_URL: "https://desktop-inference.example.test",
      },
      processEnv: {
        SHARED_KEY: "process-secret",
        PROCESS_KEY: "process-only-secret",
      },
      deterministicProvider: deterministicProvider(),
    });

    expect(resolveProviderCredential(["SHARED_KEY"], { SHARED_KEY: "store-secret" }, { SHARED_KEY: "process-secret" })).toEqual({
      envName: "SHARED_KEY",
      value: "store-secret",
    });
    expect(registrationFor(materialization, "store")?.registration.apiKey).toBe("store-secret");
    expect(registrationFor(materialization, "process")?.registration.apiKey).toBe("process-only-secret");
    expect(registrationFor(materialization, "multi")?.registration.apiKey).toBe("second-secret");
    expect(registrationFor(materialization, "none")).toBeUndefined();
    expect(materialization.providerList.connected).not.toContain("none");
    expect(registrationFor(materialization, "openwork")?.registration.baseUrl).toBe("https://desktop-inference.example.test/api/v1");
    expect(normalizeOpenWorkInferenceBaseUrl("https://already.example.test/api/v1/")).toBe("https://already.example.test/api/v1");
  });

  test("resolves credentials from the vault before env store and process env", () => {
    const parsed = parseFlueCatalogPayload(credentialCatalogFixture());
    const materialization = materializeFlueCatalog({
      catalogProviders: parsed.providers,
      runtimeConfig: {},
      vaultCredentials: { store: { type: "api", key: "vault-secret" } },
      envStore: { SHARED_KEY: "store-secret" },
      processEnv: { SHARED_KEY: "process-secret" },
      deterministicProvider: deterministicProvider(),
    });

    expect(resolveProviderCredentialWithVault(
      { type: "api", key: "vault-secret" },
      ["SHARED_KEY"],
      { SHARED_KEY: "store-secret" },
      { SHARED_KEY: "process-secret" },
    )).toEqual({ envName: null, value: "vault-secret" });
    expect(registrationFor(materialization, "store")?.registration.apiKey).toBe("vault-secret");
  });

  test("omits a disabled catalog provider before credential resolution and registration", () => {
    const parsed = parseFlueCatalogPayload(catalogFixture());
    const materialization = materializeFlueCatalog({
      catalogProviders: parsed.providers,
      runtimeConfig: { disabled_providers: [" openwork ", ""] },
      envStore: { OPENWORK_API_KEY: "ow-key" },
      processEnv: {},
      deterministicProvider: deterministicProvider(),
    });

    expectProviderAbsent(materialization, "openwork");
    expect(materialization.skipped).toContainEqual({ providerId: "openwork", reason: "disabled" });
  });

  test("disabled providers still win over a vault credential", () => {
    const parsed = parseFlueCatalogPayload(catalogFixture());
    const materialization = materializeFlueCatalog({
      catalogProviders: parsed.providers,
      runtimeConfig: { disabled_providers: ["anthropic"] },
      vaultCredentials: { anthropic: { type: "api", key: "vault-secret" } },
      envStore: {},
      processEnv: {},
      deterministicProvider: deterministicProvider(),
    });

    expectProviderAbsent(materialization, "anthropic");
    expect(materialization.skipped).toContainEqual({ providerId: "anthropic", reason: "disabled" });
  });

  test("applies runtime map precedence, baseURL override, model filters, and disabled providers", () => {
    const parsed = parseFlueCatalogPayload(catalogFixture());
    const runtimeConfig: RuntimeOpencodeConfig = {
      disabled_providers: ["disabled-provider"],
      provider: {
        openwork: {
          id: "openwork",
          name: "Runtime OpenWork",
          npm: "@ai-sdk/openai-compatible",
          env: ["RUNTIME_OPENWORK_KEY"],
          api: "https://runtime-api.example.test/v1",
          options: { baseURL: "https://runtime-base.example.test/v1" },
          whitelist: ["runtime/openwork-model", "blocked-model"],
          blacklist: ["blocked-model"],
          models: {
            "runtime/openwork-model": { name: "Runtime Model", limit: { context: 77_000, output: 7_700 } },
            "blocked-model": { name: "Blocked Model", limit: { context: 1_000, output: 100 } },
          },
        },
        "disabled-provider": {
          id: "disabled-provider",
          name: "Disabled Provider",
          npm: "@ai-sdk/openai-compatible",
          env: ["DISABLED_KEY"],
          api: "https://disabled.example.test/v1",
          models: { model: { name: "Disabled", limit: { context: 1_000, output: 100 } } },
        },
      },
    };

    const materialization = materializeFlueCatalog({
      catalogProviders: parsed.providers,
      runtimeConfig,
      envStore: {
        RUNTIME_OPENWORK_KEY: "runtime-secret",
        DISABLED_KEY: "disabled-secret",
      },
      processEnv: {},
      deterministicProvider: deterministicProvider(),
    });

    const provider = materialization.providerList.all.find((item) => item.id === "openwork");
    expect(provider?.name).toBe("Runtime OpenWork");
    expect(provider?.source).toBe("config");
    expect(Object.keys(provider?.models ?? {})).toEqual(["runtime/openwork-model"]);
    expect(registrationFor(materialization, "openwork")?.registration).toEqual({
      api: "openai-completions",
      baseUrl: "https://runtime-base.example.test/v1",
      apiKey: "runtime-secret",
      models: { "runtime/openwork-model": { contextWindow: 77_000, maxTokens: 7_700 } },
    });
    expectProviderAbsent(materialization, "disabled-provider");
    expect(materialization.skipped).toContainEqual({ providerId: "disabled-provider", reason: "disabled" });
  });

  test("removes the deterministic provider when flue is disabled", () => {
    const materialization = materializeFlueCatalog({
      catalogProviders: [],
      runtimeConfig: { disabled_providers: ["flue"] },
      envStore: {},
      processEnv: {},
      deterministicProvider: deterministicProvider(),
    });

    expect(materialization.providerList).toEqual({ all: [], default: {}, connected: [] });
    expectProviderAbsent(materialization, "flue");
  });

  test("leaves providers outside disabled_providers available", () => {
    const parsed = parseFlueCatalogPayload(catalogFixture());
    const materialization = materializeFlueCatalog({
      catalogProviders: parsed.providers,
      runtimeConfig: { disabled_providers: ["anthropic"] },
      envStore: { OPENWORK_API_KEY: "ow-key" },
      processEnv: {},
      deterministicProvider: deterministicProvider(),
    });

    expect(registrationFor(materialization, "openwork")?.registration.apiKey).toBe("ow-key");
    expect(providerIds(materialization)).toContain("openwork");
    expect(materialization.providerList.connected).toContain("openwork");
    expect(materialization.providerList.default.openwork).toBe("moonshotai/kimi-k2.7-code");
  });

  test("lists an uncredentialed runtime provider without connecting or defaulting it", () => {
    const parsed = parseFlueCatalogPayload(catalogFixture());
    const materialization = materializeFlueCatalog({
      catalogProviders: parsed.providers,
      runtimeConfig: {
        provider: {
          anthropic: {
            id: "anthropic",
            name: "Managed Anthropic",
          },
        },
      },
      envStore: {},
      processEnv: {},
      deterministicProvider: deterministicProvider(),
    });

    expect(providerIds(materialization)).toContain("anthropic");
    expect(materialization.providerList.connected).not.toContain("anthropic");
    expect(materialization.providerList.default.anthropic).toBeUndefined();
    expect(registrationFor(materialization, "anthropic")).toBeUndefined();
    expect(materialization.skipped).toContainEqual({ providerId: "anthropic", reason: "no_credential" });
    expect(flueProviderListResponseSchema.parse(materialization.providerList)).toEqual(materialization.providerList);
  });

  test("connects a Den-imported runtime provider through its vault credential", () => {
    const parsed = parseFlueCatalogPayload(catalogFixture());
    const materialization = materializeFlueCatalog({
      catalogProviders: parsed.providers,
      runtimeConfig: {
        provider: {
          anthropic: {
            id: "anthropic",
            name: "Managed Anthropic",
          },
        },
      },
      vaultCredentials: { anthropic: { type: "api", key: "den-import-secret" } },
      envStore: {},
      processEnv: {},
      deterministicProvider: deterministicProvider(),
    });

    expect(materialization.providerList.connected).toContain("anthropic");
    expect(materialization.providerList.default.anthropic).toBe("claude-sonnet-4-6");
    expect(registrationFor(materialization, "anthropic")?.registration.apiKey).toBe("den-import-secret");
  });

  test("applies global disabled_providers to workspace effective config", async () => {
    await withRuntimeWorkspace(async ({ config, workspaceId }) => {
      await writeRuntimeOpencodeConfig(config, ENGINE_GLOBAL_RUNTIME_CONFIG_ID, () => ({
        disabled_providers: ["openwork"],
      }));
      await writeRuntimeOpencodeConfig(config, workspaceId, () => ({
        disabled_providers: ["anthropic"],
      }));

      const runtimeConfig = await readEffectiveRuntimeOpencodeConfig(config, workspaceId);
      expect(runtimeConfig.disabled_providers).toEqual(["openwork", "anthropic"]);

      const parsed = parseFlueCatalogPayload(catalogFixture());
      const materialization = materializeFlueCatalog({
        catalogProviders: parsed.providers,
        runtimeConfig,
        envStore: {
          OPENWORK_API_KEY: "ow-key",
          ANTHROPIC_API_KEY: "anthropic-key",
          OPENAI_API_KEY: "openai-key",
        },
        processEnv: {},
        deterministicProvider: deterministicProvider(),
      });

      expectProviderAbsent(materialization, "openwork");
      expectProviderAbsent(materialization, "anthropic");
      expect(providerIds(materialization)).toContain("openai");
    });
  });

  test("provider list output validates and keeps the deterministic provider", () => {
    const materialization = materializeFlueCatalog({
      catalogProviders: [],
      runtimeConfig: {},
      envStore: {},
      processEnv: {},
      deterministicProvider: deterministicProvider(),
    });

    expect(flueProviderListResponseSchema.parse(materialization.providerList)).toEqual(materialization.providerList);
    expect(materialization.providerList).toEqual({
      all: [deterministicProvider()],
      default: { flue: "default" },
      connected: ["flue"],
    });
  });

  test("falls back from failed or timed-out catalog loads to disk, runtime-only, then deterministic", async () => {
    const root = await mkdtemp(join(tmpdir(), "openwork-flue-catalog-"));
    roots.push(root);
    const cachePath = join(root, "flue-catalog-cache.json");
    const writer = new FlueCatalogBridge({
      cachePath,
      resolveModelsUrl: async () => "https://models.example.test/",
      fetchCatalog: async () => jsonCatalogResponse(catalogFixture()),
    });
    await writer.materialize({
      runtimeConfig: {},
      envStore: { OPENWORK_API_KEY: "ow-key" },
      processEnv: {},
      deterministicProvider: deterministicProvider(),
    });

    resetFlueCatalogCacheForTest();
    const offline = new FlueCatalogBridge({
      cachePath,
      resolveModelsUrl: async () => "https://models.example.test/",
      fetchCatalog: async () => {
        throw new Error("offline");
      },
    });
    const fromDisk = await offline.materialize({
      runtimeConfig: {},
      envStore: { OPENWORK_API_KEY: "ow-key" },
      processEnv: {},
      deterministicProvider: deterministicProvider(),
    });
    expect(fromDisk.catalogSource).toBe("disk-cache");
    expect(fromDisk.providerList.connected).toContain("openwork");

    resetFlueCatalogCacheForTest();
    const runtimeOnlyConfig: RuntimeOpencodeConfig = {
      provider: {
        runtime: {
          id: "runtime",
          name: "Runtime Only",
          npm: "@ai-sdk/openai-compatible",
          env: ["RUNTIME_KEY"],
          api: "https://runtime.example.test/v1",
          models: { model: { name: "Runtime Model", limit: { context: 4_096, output: 512 } } },
        },
      },
    };
    const runtimeOnly = new FlueCatalogBridge({
      cachePath: join(root, "missing-cache.json"),
      resolveModelsUrl: async () => "https://models.example.test/",
      fetchCatalog: async () => {
        throw new Error("offline");
      },
    });
    const fromRuntime = await runtimeOnly.materialize({
      runtimeConfig: runtimeOnlyConfig,
      envStore: { RUNTIME_KEY: "runtime-key" },
      processEnv: {},
      deterministicProvider: deterministicProvider(),
    });
    expect(fromRuntime.catalogSource).toBe("runtime-only");
    expect(fromRuntime.providerList.connected).toEqual(["flue", "runtime"]);

    resetFlueCatalogCacheForTest();
    const timedOut = new FlueCatalogBridge({
      cachePath: join(root, "timeout-cache.json"),
      resolveModelsUrl: async () => "https://models.example.test/",
      fetchCatalog: timeoutCatalogFetch,
      fetchTimeoutMs: 5,
    });
    const deterministic = await timedOut.materialize({
      runtimeConfig: {},
      envStore: {},
      processEnv: {},
      deterministicProvider: deterministicProvider(),
    });
    expect(deterministic.catalogSource).toBe("deterministic-only");
    expect(deterministic.providerList.connected).toEqual(["flue"]);
  });

  test("defaults unknown OpenAI-compatible providers only when they look compatible", () => {
    expect(apiKindForProvider({ id: "custom-openai", name: "Custom", npm: null, baseUrl: "https://gateway.example.test" })).toEqual({
      ok: true,
      apiKind: "openai-completions",
    });
    expect(apiKindForProvider({ id: "custom", name: "Custom", npm: "@unknown/sdk", baseUrl: "https://gateway.example.test" })).toEqual({
      ok: false,
      reason: "unsupported_npm:@unknown/sdk",
    });
  });
});
