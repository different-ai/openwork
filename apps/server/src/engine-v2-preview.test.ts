import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createEngineV2Preview,
  mapRuntimeProvidersToV2Specs,
  mapRuntimeMcpToV2,
  readEngineV2PreviewState,
  resolveInitialEngineV2PreviewState,
  writeEngineV2PreviewState,
} from "./engine-v2-preview.js";
import type { ServerConfig } from "./types.js";
import * as managedV2 from "./managed-opencode-v2.js";
import * as localAuth from "./opencode-v2-local-auth.js";
import * as runtimeConfig from "./runtime-opencode-config-store.js";
import { buildOpenWorkV2Instructions } from "./opencode-v2-instructions.js";

test("v2 app guidance fits the native entry limit and uses the current native tools", () => {
  for (const connected of [true, false]) {
    const value = buildOpenWorkV2Instructions(connected);
    expect(Buffer.byteLength(JSON.stringify(value), "utf8")).toBeLessThanOrEqual(7 * 1024);
    expect(value.operatingInstructions).not.toContain("openwork-cloud_search_capabilities");
    expect(value.operatingInstructions).not.toContain("openwork-cloud_execute_capability");
    expect(value.operatingInstructions).toStartWith("You are OpenWork.");
    expect(value.connect.includes("not connected")).toBe(!connected);
  }
});

test("maps enabled MCP transports without retaining unknown runtime fields", () => {
  expect(mapRuntimeMcpToV2({ type: "remote", url: "https://example.test/mcp", oauth: false,
    headers: { Authorization: "Bearer fixture", ignored: 3 }, timeout: 2000, enabled: true, privateMetadata: "omit" }))
    .toEqual({ type: "remote", url: "https://example.test/mcp", oauth: false,
      headers: { Authorization: "Bearer fixture" }, timeout: { startup: 2000, catalog: 2000, execution: 2000 } });
  expect(mapRuntimeMcpToV2({ type: "local", command: ["node", "fixture.mjs"], environment: { FIXTURE: "value" } }))
    .toEqual({ type: "local", command: ["node", "fixture.mjs"], environment: { FIXTURE: "value" } });
  for (const value of [null, { type: "remote", url: "file:///secret" }, { type: "local", command: [] },
    { type: "remote", url: "https://example.test/mcp", enabled: false },
    { type: "remote", url: "https://example.test/mcp", disabled: true }]) expect(mapRuntimeMcpToV2(value)).toBeUndefined();
});

function testConfig(root: string): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    token: "client-token",
    hostToken: "host-token",
    configPath: join(root, "openwork-server.json"),
    approval: { mode: "manual", timeoutMs: 1_000 },
    corsOrigins: [],
    workspaces: [],
    authorizedRoots: [root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
}

test("keeps persisted engine v2 preview state when the override is unset", () => {
  const persisted = { enabled: true, chatRouting: false };
  expect(resolveInitialEngineV2PreviewState({}, persisted)).toEqual(persisted);
});

test("enables engine v2 preview and chat routing when the override is 1", () => {
  expect(resolveInitialEngineV2PreviewState(
    { OPENWORK_ENGINE_V2_PREVIEW: "1" },
    { enabled: false, chatRouting: false },
  )).toEqual({ enabled: true, chatRouting: true });
});

test("keeps persisted engine v2 preview state for an invalid override", () => {
  const persisted = { enabled: false, chatRouting: true };
  expect(resolveInitialEngineV2PreviewState(
    { OPENWORK_ENGINE_V2_PREVIEW: "invalid" },
    persisted,
  )).toEqual(persisted);
});

test("round trips enabled and chat routing state and defaults corrupt state", async () => {
  const root = await mkdtemp(join(tmpdir(), "openwork-engine-v2-preview-"));
  const config = testConfig(root);
  try {
    await writeEngineV2PreviewState(config, { enabled: true, chatRouting: true });
    expect(readEngineV2PreviewState(config)).toEqual({ enabled: true, chatRouting: true });

    await writeFile(join(root, "engine-v2-preview.json"), "{invalid", "utf8");
    expect(readEngineV2PreviewState(config)).toEqual({ enabled: false, chatRouting: false });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persists chat routing and includes it in preview status without starting the engine", async () => {
  const root = await mkdtemp(join(tmpdir(), "openwork-engine-v2-preview-"));
  const config = testConfig(root);
  const preview = createEngineV2Preview({ config });
  try {
    expect(preview.status().chatRouting).toBe(false);
    const status = await preview.setChatRouting(true);
    expect(status.chatRouting).toBe(true);
    expect(status.enabled).toBe(false);
    expect(status.running).toBe(false);
    expect(preview.connection()).toBeUndefined();
    expect(readEngineV2PreviewState(config)).toEqual({ enabled: false, chatRouting: true });
  } finally {
    await preview.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("maps runtime provider fields and models to an OpenCode v2 spec", () => {
  expect(mapRuntimeProvidersToV2Specs({
    example: {
      name: "Example Provider",
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: "https://example.test/v1", apiKey: "secret" },
      models: {
        "model-b": {},
        "model-a": { name: "Model A" },
      },
    },
  })).toEqual({
    specs: [{
      id: "example",
      name: "Example Provider",
      baseUrl: "https://example.test/v1",
      package: "@opencode-ai/ai/providers/openai-compatible",
      apiKey: "secret",
      models: [
        { id: "model-a", name: "Model A", config: { name: "Model A" } },
        { id: "model-b", name: "model-b", config: {} },
      ],
    }],
    skippedProviderIds: [],
  });
});

test("skips providers without a non-empty base URL", () => {
  const result = mapRuntimeProvidersToV2Specs({ missing: { options: { apiKey: "secret" } } });
  expect(result.skippedProviderIds).toEqual(["missing"]);
  expect(result.specs).toEqual([]);
});

test("maps providers without an API key using the preview sentinel", () => {
  expect(mapRuntimeProvidersToV2Specs({
    noKey: { options: { baseURL: "https://example.test/v1" } },
  }).specs).toEqual([{
    id: "noKey",
    name: "noKey",
    baseUrl: "https://example.test/v1",
    apiKey: "openwork-engine-v2-preview-unset",
    models: [],
  }]);
});

test("skips non-record provider values without throwing", () => {
  expect(mapRuntimeProvidersToV2Specs({ array: [], nil: null, number: 42, text: "provider" })).toEqual({
    specs: [],
    skippedProviderIds: ["array", "nil", "number", "text"],
  });
});

test("sorts mapped and skipped provider IDs deterministically", () => {
  const result = mapRuntimeProvidersToV2Specs({
    zebra: { options: { baseURL: "https://zebra.test/v1" } },
    yak: {},
    alpha: { options: { baseURL: "https://alpha.test/v1" } },
    beta: null,
  });
  expect(result.specs.map((spec) => spec.id)).toEqual(["alpha", "zebra"]);
  expect(result.skippedProviderIds).toEqual(["beta", "yak"]);
});


test("native organization providers retain their transport without an endpoint override", () => {
  const result = mapRuntimeProvidersToV2Specs({
    lpr_openai: { npm: "@ai-sdk/openai", options: { apiKey: "fixture-key" }, models: { coding: { id: "wire-model", name: "Coding", tool_call: false, limit: { context: 1000000, output: 64000 }, modalities: { input: ["text", "image", "pdf"], output: ["text"] } } } },
    lpr_anthropic: { npm: "@ai-sdk/anthropic" },
    lpr_router: { npm: "@openrouter/ai-sdk-provider" },
    unknown: { npm: "untrusted-package", options: { baseURL: "https://example.test" } },
  });
  expect(result.skippedProviderIds).toEqual(["unknown"]);
  expect(result.specs.map((spec) => spec.package)).toEqual([
    "@opencode-ai/ai/providers/anthropic", "@opencode-ai/ai/providers/openai", "@opencode-ai/ai/providers/openrouter",
  ]);
  expect(result.specs.every((spec) => spec.baseUrl === undefined)).toBe(true);
  expect(result.specs[1]?.models[0]?.config).toMatchObject({ id: "wire-model", tool_call: false, limit: { context: 1000000, output: 64000 } });
});

test("native provider api endpoint and headers survive conversion", () => {
  expect(mapRuntimeProvidersToV2Specs({ native: {
    npm: "@ai-sdk/openai", api: "https://api.openai.com/v1", options: { apiKey: "fixture", headers: { "x-tenant": "fixture" } },
  } }).specs[0]).toMatchObject({ baseUrl: "https://api.openai.com/v1", package: "@opencode-ai/ai/providers/openai", headers: { "x-tenant": "fixture" } });
});


test("resolves only each provider's declared stored credential and omits missing credentials", () => {
  const providers = {
    native: { npm: "@ai-sdk/openai", env: ["NATIVE_API_KEY"] },
    missing: { npm: "@ai-sdk/openai", env: ["MISSING_API_KEY"] },
  };
  const first = mapRuntimeProvidersToV2Specs(providers, new Map([["NATIVE_API_KEY", "key-one"], ["DATABASE_URL", "unrelated-secret"]]));
  expect(first.specs[0]?.apiKey).toBe("key-one");
  expect(first.skippedProviderIds).toEqual(["missing"]);
  expect(JSON.stringify(first)).not.toContain("unrelated-secret");
  const rotated = mapRuntimeProvidersToV2Specs(providers, new Map([["NATIVE_API_KEY", "key-two"]]));
  expect(rotated.specs[0]?.apiKey).toBe("key-two");
});


test("catalog api metadata cannot redirect a stored credential off the native trusted origin", () => {
  for (const api of ["http://127.0.0.1/v1", "https://attacker.example/v1", "https://api.openai.com.attacker.example/v1", "https://api.openai.com:444/v1", "https://user@api.openai.com/v1"]) {
    const result = mapRuntimeProvidersToV2Specs({ native: { npm: "@ai-sdk/openai", api, env: ["NATIVE_API_KEY"] } }, new Map([["NATIVE_API_KEY", "private-fixture-key"]]));
    expect(result.skippedProviderIds).toEqual(["native"]);
    expect(result.specs).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("private-fixture-key");
  }
});


test("null or empty native endpoint overrides cannot bypass catalog origin validation", () => {
  for (const baseURL of [null, "", "  ", 0, false, {}]) {
    const result = mapRuntimeProvidersToV2Specs({ native: {
      npm: "@ai-sdk/openai", api: "https://untrusted.example/v1",
      options: { baseURL }, env: ["NATIVE_API_KEY"],
    } }, new Map([["NATIVE_API_KEY", "private-fixture-key"]]));
    expect(result.skippedProviderIds).toEqual(["native"]);
    expect(result.specs).toEqual([]);
  }
});


type FakeSidecarReply = { status: number; json: unknown };

/** A running engine v2 preview over a scripted sidecar; nothing is spawned. */
async function withFakeSidecar(
  input: {
    reply: (path: string, method: string, body?: unknown) => FakeSidecarReply | Promise<FakeSidecarReply>;
    providers?: Record<string, unknown>;
    disabledProviders?: string[];
    onSetProviders?: (specs: managedV2.OpencodeV2ProviderSpec[], disabled: string[] | undefined) => void;
    mcp?: Record<string, Record<string, unknown>>;
    waits?: Parameters<typeof createEngineV2Preview>[0]["waits"];
  },
  run: (preview: ReturnType<typeof createEngineV2Preview>, root: string, calls: string[]) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "openwork-v2-upkeep-"));
  const calls: string[] = [];
  const fake = {
    url: "http://127.0.0.1:1", username: "opencode", password: "fixture", childPid: 1, exitCode: null, stdout: "", stderr: "",
    health: async () => ({ healthy: true, version: "fixture", pid: 1 }),
    injectProvider: async () => {},
    setProviders: async (specs: managedV2.OpencodeV2ProviderSpec[], disabled?: string[]) => { input.onSetProviders?.(specs, disabled); },
    setSkills: async () => {}, close: async () => {},
    async fetchJson(path: string, init: { method?: string; body?: unknown } = {}) {
      const method = init.method ?? "GET";
      calls.push(`${method} ${path}`);
      return await input.reply(path, method, init.body);
    },
  } satisfies managedV2.ManagedOpencodeV2Server;
  const spies = [
    spyOn(managedV2, "createManagedOpencodeV2Server").mockResolvedValue(fake),
    spyOn(localAuth, "readLocalProviderApiKeys").mockResolvedValue(new Map()),
    spyOn(runtimeConfig, "readGlobalRuntimeOpencodeConfig").mockResolvedValue({
      provider: input.providers ?? {},
      ...(input.disabledProviders ? { disabled_providers: input.disabledProviders } : {}),
    }),
    spyOn(runtimeConfig, "readEffectiveRuntimeOpencodeConfig").mockImplementation(async () => ({ mcp: structuredClone(input.mcp ?? {}) })),
  ];
  const previousBin = process.env.OPENWORK_OPENCODE2_BIN;
  process.env.OPENWORK_OPENCODE2_BIN = "opencode2-fixture";
  const preview = createEngineV2Preview({ config: testConfig(root), deferStart: true, waits: input.waits });
  try {
    await preview.setEnabled(true);
    for (let attempt = 0; attempt < 200 && !preview.status().running; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(preview.status().running).toBe(true);
    await run(preview, root, calls);
  } finally {
    await preview.stop();
    for (const spy of spies) spy.mockRestore();
    if (previousBin === undefined) delete process.env.OPENWORK_OPENCODE2_BIN;
    else process.env.OPENWORK_OPENCODE2_BIN = previousBin;
    await rm(root, { recursive: true, force: true });
  }
}

const orgProvider = { orga: { name: "Org A", options: { baseURL: "https://example.test/v1", apiKey: "fixture-key" }, models: { m1: { name: "M1" } } } };

test("the v2 mirror applies the same disabled_providers as v1, so Disconnect hides OpenCode Zen in both engines", async () => {
  const pushes: Array<{ ids: string[]; disabled: string[] | undefined }> = [];
  await withFakeSidecar({
    providers: { ...orgProvider, orgb: { name: "Org B", options: { baseURL: "https://b.example.test/v1", apiKey: "fixture-key" }, models: { m2: {} } } },
    disabledProviders: ["opencode", "orgb"],
    onSetProviders: (specs, disabled) => pushes.push({ ids: specs.map((spec) => spec.id), disabled }),
    reply: (path) => path === "/api/model"
      ? { status: 200, json: { data: [{ id: "m1", providerID: "orga" }] } }
      : { status: 200, json: { data: [] } },
  }, async (preview) => {
    await preview.refreshProviders();
    expect(pushes.at(-1)).toEqual({ ids: ["orga"], disabled: ["opencode", "orgb"] });
    expect(preview.status().mirroredProviderIds).toEqual(["orga"]);
    expect(preview.status().lastError).toBeUndefined();
  });
});

test("folder readiness joins the provider push, not the slow catalog confirmation", async () => {
  const started = Date.now();
  await withFakeSidecar({
    providers: orgProvider,
    reply: (path) => {
      if (path === "/api/provider") return { status: 200, json: { data: [{ id: "orga", settings: { apiKey: "fixture-key" } }] } };
      // The catalog confirmation lags for over a second, as a cold sidecar does.
      if (path === "/api/model") return { status: 200, json: { data: Date.now() - started > 1_200 ? [{ id: "m1", providerID: "orga" }] : [] } };
      return { status: 200, json: { data: [] } };
    },
  }, async (preview, root) => {
    const before = Date.now();
    await preview.ensureWorkspaceReady(root);
    expect(Date.now() - before).toBeLessThan(800);
    expect(preview.status().lastWarning).toBeUndefined();
  });
});

test("a folder whose catalog never lists the mirrored providers is served after a bounded wait, not refused", async () => {
  await withFakeSidecar({
    providers: orgProvider,
    waits: { workspaceProviderReadyMs: 150 },
    reply: (path) => path === "/api/model"
      ? { status: 200, json: { data: [{ id: "m1", providerID: "orga" }] } }
      : { status: 200, json: { data: [] } },
  }, async (preview, root, calls) => {
    await preview.ensureWorkspaceReady(root);
    expect(preview.status().lastWarning).toContain("did not list every mirrored provider");
    // The outcome is reused until the next mirror, so polls never repeat the wait.
    const reads = calls.length;
    await preview.ensureWorkspaceReady(root);
    expect(calls.length).toBe(reads);
  });
});

/**
 * A scripted engine MCP registry with the pinned engine's semantics: a PUT
 * connects before it answers and is ignored when identical to the current
 * config; /connect closes and reopens the client; DELETE forgets it.
 */
function fakeMcpEngine(input: { connectMs?: number; up?: (name: string) => boolean } = {}) {
  const servers = new Map<string, { config: string; status: string }>();
  const log: string[] = [];
  const connect = async (name: string) => {
    const server = servers.get(name);
    if (!server) return;
    server.status = "pending";
    await new Promise((resolve) => setTimeout(resolve, input.connectMs ?? 0));
    server.status = (input.up?.(name) ?? true) ? "connected" : "failed";
  };
  return {
    servers, log,
    async reply(path: string, method: string, body?: unknown): Promise<FakeSidecarReply> {
      const name = decodeURIComponent(path.split("/")[3] ?? "");
      if (path === "/api/mcp" && method === "GET") {
        return { status: 200, json: { data: [...servers].map(([name, server]) => ({ name, status: { status: server.status } })) } };
      }
      if (path.endsWith("/connect") && method === "POST") { log.push(`connect ${name}`); await connect(name); return { status: 204, json: null }; }
      if (method === "PUT") {
        const config = JSON.stringify(body);
        if (servers.get(name)?.config === config) return { status: 204, json: null };
        log.push(`put ${name}`);
        servers.set(name, { config, status: "pending" });
        await connect(name);
        return { status: 204, json: null };
      }
      if (method === "DELETE") { log.push(`delete ${name}`); servers.delete(name); return { status: 204, json: null }; }
      return { status: 200, json: { data: [] } };
    },
  };
}

test("a connection the engine rejects is skipped and backed off without blocking the others", async () => {
  const engine = fakeMcpEngine();
  await withFakeSidecar({
    mcp: { good: { type: "remote", url: "https://good.example/mcp" }, broken: { type: "remote", url: "https://broken.example/mcp" } },
    reply: (path, method, body) => path === "/api/mcp/broken" ? { status: 400, json: { message: "unsupported" } } : engine.reply(path, method, body),
  }, async (preview, root, calls) => {
    await preview.syncWorkspaceMcp("ws_1", root);
    await preview.syncWorkspaceMcp("ws_1", root);
    expect(calls.filter((call) => call === "PUT /api/mcp/broken")).toHaveLength(1);
    expect(engine.log).toEqual(["put good"]);
    expect(preview.status().lastWarning).toContain("broken: registration failed (400)");
    expect(preview.status().lastError).toBeUndefined();
  });
});

test("a refresh never re-registers or restarts a healthy connection", async () => {
  const engine = fakeMcpEngine();
  await withFakeSidecar({
    mcp: { "openwork-direct-a": { type: "remote", url: "https://a.example/mcp" }, "openwork-direct-b": { type: "remote", url: "https://b.example/mcp" } },
    reply: engine.reply,
  }, async (preview, root) => {
    await preview.syncWorkspaceMcp("ws_1", root);
    expect(engine.log.sort()).toEqual(["put openwork-direct-a", "put openwork-direct-b"]);
    // The desktop refresh names the connections explicitly; healthy ones stay up.
    for (let refresh = 0; refresh < 3; refresh++) {
      await preview.syncWorkspaceMcp("ws_1", root, { reconnect: ["openwork-direct-a", "openwork-direct-b"] });
    }
    expect(engine.log).toHaveLength(2);
  });
});

test("connections are restarted side by side, not one after another", async () => {
  // The pinned engine serializes PUTs itself, but restarts only lock their own name.
  const timing = { connectMs: 0, up: false };
  const engine = fakeMcpEngine({ get connectMs() { return timing.connectMs; }, up: () => timing.up });
  const mcp = Object.fromEntries(["a", "b", "c", "d"].map((name) => [name, { type: "remote", url: `https://${name}.example/mcp` }]));
  await withFakeSidecar({ mcp, reply: engine.reply, waits: { mcpRetryMs: 0 } }, async (preview, root) => {
    await preview.syncWorkspaceMcp("ws_1", root);
    Object.assign(timing, { connectMs: 300, up: true });
    const started = Date.now();
    await preview.syncWorkspaceMcp("ws_1", root);
    expect(Date.now() - started).toBeLessThan(900);
    expect([...engine.servers.values()].map((server) => server.status)).toEqual(["connected", "connected", "connected", "connected"]);
    expect(engine.log.filter((entry) => entry.startsWith("connect"))).toHaveLength(4);
  });
});

test("a connection that failed to start is restarted with /connect after the back-off, then left alone", async () => {
  // Accepted with 204, then the local app was closed: the engine reports failed
  // and never retries on its own, and it ignores an identical PUT.
  let appUp = false;
  const engine = fakeMcpEngine({ up: () => appUp });
  await withFakeSidecar({
    waits: { mcpRetryMs: 300 },
    mcp: { "paper-local": { type: "remote", url: "http://127.0.0.1:29979/mcp" } },
    reply: engine.reply,
  }, async (preview, root) => {
    await preview.syncWorkspaceMcp("ws_1", root);
    expect(engine.servers.get("paper-local")?.status).toBe("failed");
    // The first sync that sees the failure restarts it once; within the back-off it is not hammered.
    await preview.syncWorkspaceMcp("ws_1", root);
    await preview.syncWorkspaceMcp("ws_1", root);
    expect(engine.log).toEqual(["put paper-local", "connect paper-local"]);
    expect(preview.status().lastWarning).toContain("paper-local: connection failed; reconnecting");
    appUp = true;
    await new Promise((resolve) => setTimeout(resolve, 350));
    await preview.syncWorkspaceMcp("ws_1", root);
    expect(engine.servers.get("paper-local")?.status).toBe("connected");
    await new Promise((resolve) => setTimeout(resolve, 350));
    await preview.syncWorkspaceMcp("ws_1", root);
    expect(engine.log).toEqual(["put paper-local", "connect paper-local", "connect paper-local"]);
  });
});

test("an explicit reconnect skips the back-off for that connection only", async () => {
  const engine = fakeMcpEngine({ up: () => false });
  await withFakeSidecar({
    mcp: { a: { type: "remote", url: "https://a.example/mcp" }, b: { type: "remote", url: "https://b.example/mcp" } },
    reply: engine.reply,
  }, async (preview, root) => {
    await preview.syncWorkspaceMcp("ws_1", root);
    await preview.syncWorkspaceMcp("ws_1", root);
    engine.log.length = 0;
    await preview.syncWorkspaceMcp("ws_1", root, { reconnect: ["a"] });
    expect(engine.log).toEqual(["connect a"]);
  });
});

test("the periodic health pass restarts a failed connection without any request", async () => {
  let appUp = false;
  const engine = fakeMcpEngine({ up: () => appUp });
  await withFakeSidecar({
    waits: { mcpRetryMs: 0, mcpHealthMs: 100 },
    mcp: { "paper-local": { type: "remote", url: "http://127.0.0.1:29979/mcp" } },
    reply: engine.reply,
  }, async (preview, root) => {
    preview.warmWorkspace("ws_1", root);
    for (let attempt = 0; attempt < 50 && engine.servers.get("paper-local")?.status !== "failed"; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    appUp = true;
    for (let attempt = 0; attempt < 50 && engine.servers.get("paper-local")?.status !== "connected"; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(engine.servers.get("paper-local")?.status).toBe("connected");
    expect(engine.log).toContain("connect paper-local");
  });
});

test("a removed connection is deleted and a changed one is registered again", async () => {
  const engine = fakeMcpEngine();
  const mcp: Record<string, Record<string, unknown>> = {
    kept: { type: "remote", url: "https://kept.example/mcp" },
    removed: { type: "remote", url: "https://removed.example/mcp" },
    rotated: { type: "remote", url: "https://rotated.example/mcp", headers: { Authorization: "Bearer one" } },
  };
  await withFakeSidecar({ mcp, reply: engine.reply }, async (preview, root) => {
    await preview.syncWorkspaceMcp("ws_1", root);
    engine.log.length = 0;
    delete mcp.removed;
    mcp.rotated = { type: "remote", url: "https://rotated.example/mcp", headers: { Authorization: "Bearer two" } };
    await preview.syncWorkspaceMcp("ws_1", root);
    expect(engine.log.sort()).toEqual(["delete removed", "delete rotated", "put rotated"]);
    expect(engine.servers.get("rotated")?.config).toContain("Bearer two");
    expect([...engine.servers.keys()].sort()).toEqual(["kept", "rotated"]);
  });
});

test("a connection the engine no longer lists is registered again", async () => {
  const engine = fakeMcpEngine();
  await withFakeSidecar({ mcp: { good: { type: "remote", url: "https://good.example/mcp" } }, reply: engine.reply }, async (preview, root) => {
    await preview.syncWorkspaceMcp("ws_1", root);
    engine.servers.clear();
    await preview.syncWorkspaceMcp("ws_1", root);
    expect(engine.log).toEqual(["put good", "put good"]);
  });
});

test("triggers that arrive while a run is in flight share one follow-up run", async () => {
  let releaseRegistration = () => {};
  const registration = new Promise<void>((resolve) => { releaseRegistration = resolve; });
  const engine = fakeMcpEngine();
  await withFakeSidecar({
    mcp: { good: { type: "remote", url: "https://good.example/mcp" } },
    reply: async (path, method, body) => { if (method === "PUT") await registration; return engine.reply(path, method, body); },
  }, async (preview, root, calls) => {
    const first = preview.syncWorkspaceMcp("ws_1", root);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const burst = [1, 2, 3, 4].map(() => preview.syncWorkspaceMcp("ws_1", root));
    releaseRegistration();
    await Promise.all([first, ...burst]);
    expect(calls.filter((call) => call === "GET /api/mcp")).toHaveLength(2);
    expect(engine.log).toEqual(["put good"]);
  });
});

test("warming a folder starts its upkeep in the background without waiting", async () => {
  let releaseRegistration = () => {};
  const registration = new Promise<void>((resolve) => { releaseRegistration = resolve; });
  const engine = fakeMcpEngine();
  await withFakeSidecar({
    mcp: { good: { type: "remote", url: "https://good.example/mcp" } },
    reply: async (path, method, body) => { if (method === "PUT") await registration; return engine.reply(path, method, body); },
  }, async (preview, root, calls) => {
    preview.warmWorkspace("ws_1", root);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toContain("PUT /api/mcp/good");
    preview.warmWorkspace("ws_1", root);
    releaseRegistration();
    await preview.syncWorkspaceMcp("ws_1", root);
    expect(calls.filter((call) => call === "PUT /api/mcp/good")).toHaveLength(1);
  });
});
