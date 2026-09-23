import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalProviderKeys } from "./local-provider-keys.js";
import { EnvService } from "./env-file.js";
import type { ServerConfig } from "./types.js";
import { readGlobalRuntimeOpencodeConfig, writeGlobalRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";

async function fixture(run: (keys: LocalProviderKeys, env: EnvService, config: ServerConfig) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "local-provider-key-test-"));
  const previous = process.env.OPENWORK_RUNTIME_DB;
  process.env.OPENWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  const config: ServerConfig = {
    host: "127.0.0.1", port: 9876, token: "fixture-client", hostToken: "fixture-host", configPath: join(root, "server.json"), approval: { mode: "auto", timeoutMs: 0 }, corsOrigins: [], workspaces: [], authorizedRoots: [root], readOnly: false, startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "pretty", logRequests: false,
    anonymousInference: { desktop: { currentVersion: "0.20.0", identity: async () => ({ machineId: "c".repeat(64), publicKey: "fixture-public-key", appVersion: "0.20.0", platform: "darwin", arch: "arm64" }), sign: async () => "fixture-proof" } },
  };
  const env = new EnvService({ path: join(root, "env.json") });
  try { await run(new LocalProviderKeys(config, env), env, config); }
  finally { if (previous === undefined) delete process.env.OPENWORK_RUNTIME_DB; else process.env.OPENWORK_RUNTIME_DB = previous; await rm(root, { recursive: true, force: true }); }
}

test("device key storage writes a runtime pointer, never the key into public metadata", async () => {
  await fixture(async (keys, env, config) => {
    await keys.save("anthropic", "fixture-private-key");
    expect(await keys.describe("anthropic")).toMatchObject({ name: "Anthropic", providerId: "anthropic" });
    expect(JSON.stringify(await readGlobalRuntimeOpencodeConfig(config))).not.toContain("fixture-private-key");
    expect((await env.readSecret("LOCAL_PROVIDER_ANTHROPIC_API_KEY"))?.value).toBe("fixture-private-key");
    expect(JSON.stringify(await keys.describe("anthropic"))).not.toContain("fixture-private-key");
  });
});

test("unsupported and custom provider definitions remain untouched", async () => {
  await fixture(async (keys, env, config) => {
    const custom = { npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://custom.example.test" } };
    await writeGlobalRuntimeOpencodeConfig(config, (current) => ({ ...current, provider: { anthropic: custom } }));
    await expect(keys.save("anthropic", "fixture-key")).rejects.toMatchObject({ code: "local_key_unavailable" });
    await expect(keys.save("custom", "fixture-key")).rejects.toMatchObject({ code: "local_key_unavailable" });
    expect((await readGlobalRuntimeOpencodeConfig(config)).provider?.anthropic).toEqual(custom);
    expect(await env.list()).toHaveLength(0);
  });
});

test("removal cannot erase a replacement key or run after identity invalidation", async () => {
  await fixture(async (keys, env) => {
    await keys.save("anthropic", "fixture-first-key");
    const first = await keys.read("anthropic");
    await keys.save("anthropic", "fixture-replacement-key");
    expect(await keys.remove("anthropic", first, () => {})).toBe(false);
    const replacement = await keys.read("anthropic");
    await expect(keys.remove("anthropic", replacement, () => { throw new Error("Identity changed"); })).rejects.toThrow("Identity changed");
    expect((await env.readSecret(replacement.key))?.value).toBe("fixture-replacement-key");
    expect(await keys.remove("anthropic", replacement, () => {})).toBe(true);
    expect(await env.readSecret(replacement.key)).toBeNull();
  });
});
