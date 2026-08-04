import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetManagedProviderAuthCache, syncManagedProviderAuth } from "./managed-provider-auth.js";
import { ENGINE_GLOBAL_RUNTIME_CONFIG_ID, writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";

type Call = { method: string; url: string; body: unknown; authorization: string | null };

const PROVIDER = "lpr_01kyhvcrn0eshb3rp2dt10z29j";

function stubFetch(status = 200) {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? "GET",
      url: String(input),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      authorization: new Headers(init?.headers).get("authorization"),
    });
    return new Response(status >= 400 ? "nope" : "{}", { status });
  }) as unknown as typeof globalThis.fetch;
  return { calls, impl };
}

async function makeConfig(dir: string): Promise<ServerConfig> {
  const config = {
    port: 0,
    token: "test-token",
    approval: "manual",
    readOnly: false,
    storageDir: dir,
    opencodeBaseUrl: "http://127.0.0.1:39999",
    opencodeUsername: "engine-user",
    opencodePassword: "engine-pass",
    workspaces: [
      {
        id: "ws_test",
        name: "test",
        path: join(dir, "workspace"),
      },
    ],
  } as unknown as ServerConfig;
  return config;
}

async function seedProvider(config: ServerConfig, entry: Record<string, unknown>): Promise<void> {
  await writeRuntimeOpencodeConfig(config, ENGINE_GLOBAL_RUNTIME_CONFIG_ID, (current) => ({
    ...current,
    provider: { [PROVIDER]: entry },
  }));
}

describe("managed provider auth delivery", () => {
  let dir: string;

  beforeEach(async () => {
    resetManagedProviderAuthCache();
    dir = await mkdtemp(join(tmpdir(), "openwork-provider-auth-"));
  });

  test("delivers a stored credential to the engine auth API", async () => {
    const config = await makeConfig(dir);
    await seedProvider(config, { id: "anthropic", name: "Ben - Anthropic", env: ["ANTHROPIC_API_KEY"] });
    const fetchStub = stubFetch();

    const result = await syncManagedProviderAuth({
      config,
      env: { list: async () => [{ key: "ANTHROPIC_API_KEY", value: "sk-ant-secret" }] },
      fetchImpl: fetchStub.impl,
    });

    expect(result.delivered).toEqual([PROVIDER]);
    expect(fetchStub.calls).toHaveLength(1);
    expect(fetchStub.calls[0]?.method).toBe("PUT");
    expect(fetchStub.calls[0]?.url).toBe(`http://127.0.0.1:39999/auth/${PROVIDER}`);
    expect(fetchStub.calls[0]?.body).toEqual({ type: "api", key: "sk-ant-secret" });
    expect(fetchStub.calls[0]?.authorization).toBe(
      `Basic ${Buffer.from("engine-user:engine-pass").toString("base64")}`,
    );
    await rm(dir, { recursive: true, force: true });
  });

  test("does not re-deliver an unchanged credential", async () => {
    const config = await makeConfig(dir);
    await seedProvider(config, { id: "anthropic", env: ["ANTHROPIC_API_KEY"] });
    const fetchStub = stubFetch();
    const env = { list: async () => [{ key: "ANTHROPIC_API_KEY", value: "sk-ant-secret" }] };

    await syncManagedProviderAuth({ config, env, fetchImpl: fetchStub.impl });
    const second = await syncManagedProviderAuth({ config, env, fetchImpl: fetchStub.impl });

    expect(second.unchanged).toEqual([PROVIDER]);
    expect(fetchStub.calls.filter((call) => call.method === "PUT")).toHaveLength(1);
    await rm(dir, { recursive: true, force: true });
  });

  test("re-delivers after the credential rotates", async () => {
    const config = await makeConfig(dir);
    await seedProvider(config, { id: "anthropic", env: ["ANTHROPIC_API_KEY"] });
    const fetchStub = stubFetch();
    let value = "sk-ant-first";
    const env = { list: async () => [{ key: "ANTHROPIC_API_KEY", value }] };

    await syncManagedProviderAuth({ config, env, fetchImpl: fetchStub.impl });
    value = "sk-ant-rotated";
    const second = await syncManagedProviderAuth({ config, env, fetchImpl: fetchStub.impl });

    expect(second.delivered).toEqual([PROVIDER]);
    const puts = fetchStub.calls.filter((call) => call.method === "PUT");
    expect(puts).toHaveLength(2);
    expect(puts[1]?.body).toEqual({ type: "api", key: "sk-ant-rotated" });
    await rm(dir, { recursive: true, force: true });
  });

  test("skips a provider whose credential is not in the env store", async () => {
    const config = await makeConfig(dir);
    await seedProvider(config, { id: "anthropic", env: ["ANTHROPIC_API_KEY"] });
    const fetchStub = stubFetch();
    const warnings: Array<Record<string, unknown> | undefined> = [];

    const result = await syncManagedProviderAuth({
      config,
      env: { list: async () => [] },
      fetchImpl: fetchStub.impl,
      logger: { warn: (_m, meta) => warnings.push(meta), error: () => {} },
    });

    expect(result.skipped).toEqual([{ providerId: PROVIDER, reason: "no_stored_credential" }]);
    expect(fetchStub.calls).toHaveLength(0);
    expect(JSON.stringify(warnings)).not.toContain("sk-");
    await rm(dir, { recursive: true, force: true });
  });

  test("removes engine auth for a provider this process delivered and that is no longer managed", async () => {
    const config = await makeConfig(dir);
    await seedProvider(config, { id: "anthropic", env: ["ANTHROPIC_API_KEY"] });
    const fetchStub = stubFetch();
    const env = { list: async () => [{ key: "ANTHROPIC_API_KEY", value: "sk-ant-secret" }] };
    await syncManagedProviderAuth({ config, env, fetchImpl: fetchStub.impl });

    await writeRuntimeOpencodeConfig(config, ENGINE_GLOBAL_RUNTIME_CONFIG_ID, (current) => ({
      ...current,
      provider: {},
    }));
    const result = await syncManagedProviderAuth({ config, env, fetchImpl: fetchStub.impl });

    expect(result.removed).toEqual([PROVIDER]);
    expect(fetchStub.calls.some((call) => call.method === "DELETE" && call.url.endsWith(PROVIDER))).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });

  test("never touches providers this process did not deliver", async () => {
    const config = await makeConfig(dir);
    // No managed providers at all: a desktop user's own engine credentials must
    // not be deleted just because the managed map is empty.
    await writeRuntimeOpencodeConfig(config, ENGINE_GLOBAL_RUNTIME_CONFIG_ID, (current) => ({
      ...current,
      provider: {},
    }));
    const fetchStub = stubFetch();

    const result = await syncManagedProviderAuth({
      config,
      env: { list: async () => [{ key: "ANTHROPIC_API_KEY", value: "sk-ant-secret" }] },
      fetchImpl: fetchStub.impl,
    });

    expect(result.delivered).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(fetchStub.calls).toHaveLength(0);
    await rm(dir, { recursive: true, force: true });
  });

  test("reports an engine rejection with its status and no credential", async () => {
    const config = await makeConfig(dir);
    await seedProvider(config, { id: "anthropic", env: ["ANTHROPIC_API_KEY"] });
    const fetchStub = stubFetch(401);
    const errors: Array<Record<string, unknown> | undefined> = [];

    const result = await syncManagedProviderAuth({
      config,
      env: { list: async () => [{ key: "ANTHROPIC_API_KEY", value: "sk-ant-secret" }] },
      fetchImpl: fetchStub.impl,
      logger: { warn: () => {}, error: (_m, meta) => errors.push(meta) },
    });

    expect(result.failed).toEqual([{ providerId: PROVIDER, status: 401 }]);
    expect(JSON.stringify(errors)).toContain("401");
    expect(JSON.stringify(errors)).not.toContain("sk-ant-secret");
    await rm(dir, { recursive: true, force: true });
  });

  test("re-delivers after the engine is replaced", async () => {
    const config = await makeConfig(dir);
    await seedProvider(config, { id: "anthropic", env: ["ANTHROPIC_API_KEY"] });
    const fetchStub = stubFetch();
    const env = { list: async () => [{ key: "ANTHROPIC_API_KEY", value: "sk-ant-secret" }] };

    await syncManagedProviderAuth({ config, env, fetchImpl: fetchStub.impl });
    resetManagedProviderAuthCache();
    const afterRestart = await syncManagedProviderAuth({ config, env, fetchImpl: fetchStub.impl });

    expect(afterRestart.delivered).toEqual([PROVIDER]);
    expect(fetchStub.calls.filter((call) => call.method === "PUT")).toHaveLength(2);
    await rm(dir, { recursive: true, force: true });
  });
});
