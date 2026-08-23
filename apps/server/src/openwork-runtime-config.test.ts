import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildOpenworkRuntimeConfig,
  keepOpenworkRuntimeConfigFileFresh,
  openworkRuntimeConfigFilePath,
  writeOpenworkRuntimeConfigFile,
} from "./openwork-runtime-config.js";
import { writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";
import { closeWorkspaceKvStoreDatabasesForTests } from "./workspace-kv-store.js";
import { EnvService } from "./env-file.js";

const roots: string[] = [];
const cleanups: Array<() => void> = [];
let previousDb: string | undefined;

afterEach(async () => {
  while (cleanups.length) cleanups.pop()?.();
  await closeWorkspaceKvStoreDatabasesForTests();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
  if (previousDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
  else process.env.OPENWORK_RUNTIME_DB = previousDb;
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "openwork-runtime-config-file-"));
  roots.push(root);
  previousDb = process.env.OPENWORK_RUNTIME_DB;
  process.env.OPENWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    token: "owt_test_token",
    hostToken: "owt_host_token",
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [
      { id: "ws_1", name: "Workspace", path: root, preset: "starter", workspaceType: "local" },
    ],
    authorizedRoots: [root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
  return { root, config };
}

async function readConfigFile(config: ServerConfig): Promise<Record<string, unknown>> {
  const raw = await readFile(openworkRuntimeConfigFilePath(config), "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

describe("openwork runtime config file", () => {
  test("writes runtime-DB MCPs and openwork defaults into the file", async () => {
    const { config } = await setup();
    await writeRuntimeOpencodeConfig(config, "ws_1", (current) => ({
      ...current,
      mcp: {
        posthog: { type: "remote", url: "https://mcp.posthog.com/mcp", enabled: true },
        "openwork-connect-stale": { type: "remote", url: "https://cloud.example/stale", enabled: true },
      },
    }));

    const { path } = await writeOpenworkRuntimeConfigFile(config, "ws_1");
    expect(path).toBe(openworkRuntimeConfigFilePath(config));

    const parsed = await readConfigFile(config);
    const mcp = parsed.mcp as Record<string, Record<string, unknown>>;
    expect(mcp.posthog?.enabled).toBe(true);
    expect(mcp["openwork-connect-stale"]).toBeUndefined();
    expect(parsed.default_agent).toBe("openwork");
    expect(Array.isArray(parsed.plugin)).toBe(true);
    expect(parsed.agent).toMatchObject({
      openwork: {
        permission: {
          skill: {
            "customize-opencode": "deny",
            "get-started": "deny",
            "command-creator": "deny",
            "agent-creator": "deny",
            "plugin-creator": "deny",
          },
        },
      },
    });
  });

  test("openwork prompt has a static search-first Memory Bank section, distinct from ## Memory", async () => {
    const { config } = await setup();
    await writeOpenworkRuntimeConfigFile(config, "ws_1");

    const parsed = await readConfigFile(config);
    const agent = parsed.agent as Record<string, { prompt?: string }>;
    const prompt = agent.openwork?.prompt ?? "";

    // The new Memory Bank section is present and distinct from the existing ## Memory section.
    expect(prompt).toContain("## Memory Bank");
    expect(prompt).toContain("## Memory\n");
    // Search-first (B1): never name tools that do not exist.
    expect(prompt).toContain("search_capabilities");
    expect(prompt).toContain("execute_capability");
    expect(prompt).not.toContain("memory_save");
    expect(prompt).not.toContain("memory_search");
    // No-secrets guidance is the only v0 plaintext-at-rest mitigation.
    expect(prompt).toMatch(/secret|credential|API key|token|PII/i);
  });

  test("keepOpenworkRuntimeConfigFileFresh rewrites the file on runtime-DB writes", async () => {
    const { config } = await setup();
    await writeOpenworkRuntimeConfigFile(config, "ws_1");
    cleanups.push(keepOpenworkRuntimeConfigFileFresh(config, "ws_1"));

    await writeRuntimeOpencodeConfig(config, "ws_1", (current) => ({
      ...current,
      mcp: { stripe: { type: "remote", url: "https://mcp.stripe.com", enabled: false } },
    }));

    // The refresh is fire-and-forget; poll briefly for the rewrite.
    let mcp: Record<string, Record<string, unknown>> = {};
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const parsed = await readConfigFile(config);
      mcp = (parsed.mcp ?? {}) as Record<string, Record<string, unknown>>;
      if (mcp.stripe) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(mcp.stripe?.enabled).toBe(false);
  });

  test("writes for other workspaces do not rewrite the primary file", async () => {
    const { config } = await setup();
    await writeOpenworkRuntimeConfigFile(config, "ws_1");
    cleanups.push(keepOpenworkRuntimeConfigFileFresh(config, "ws_1"));

    await writeRuntimeOpencodeConfig(config, "ws_other", (current) => ({
      ...current,
      mcp: { other: { type: "remote", url: "https://example.com/mcp", enabled: true } },
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const parsed = await readConfigFile(config);
    const mcp = (parsed.mcp ?? {}) as Record<string, Record<string, unknown>>;
    expect(mcp.other).toBeUndefined();
  });

  test("builds byte-stable config for repeated snapshots", async () => {
    const { config } = await setup();
    await writeRuntimeOpencodeConfig(config, "ws_1", (current) => ({
      ...current,
      mcp: { posthog: { type: "remote", url: "https://mcp.posthog.com/mcp" } },
    }));

    const first = await buildOpenworkRuntimeConfig(config, "ws_1");
    const second = await buildOpenworkRuntimeConfig(config, "ws_1");

    expect(second).toBe(first);
  });

  test("builds byte-stable config for equivalent snapshots with different key order", async () => {
    const { config } = await setup();
    await writeRuntimeOpencodeConfig(config, "ws_1", () => ({
      mcp: {
        zeta: { url: "https://z.example/mcp", type: "remote" },
        alpha: { type: "remote", url: "https://a.example/mcp" },
      },
      provider: {
        zeta: { npm: "@ai-sdk/openai-compatible", name: "Zeta" },
        alpha: { name: "Alpha", npm: "@ai-sdk/openai-compatible" },
      },
    }));
    const first = await buildOpenworkRuntimeConfig(config, "ws_1");

    await writeRuntimeOpencodeConfig(config, "ws_1", () => ({
      provider: {
        alpha: { npm: "@ai-sdk/openai-compatible", name: "Alpha" },
        zeta: { name: "Zeta", npm: "@ai-sdk/openai-compatible" },
      },
      mcp: {
        alpha: { url: "https://a.example/mcp", type: "remote" },
        zeta: { type: "remote", url: "https://z.example/mcp" },
      },
    }));
    const second = await buildOpenworkRuntimeConfig(config, "ws_1");

    expect(second).toBe(first);
  });
});

describe("cursor-acp provider injection", () => {
  const GLOBAL_CONFIG_WITH_CURSOR_ACP = JSON.stringify({
    plugin: ["cursor-acp"],
    provider: {
      "cursor-acp": {
        name: "Cursor",
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "http://127.0.0.1:32124/v1" },
        models: { auto: { name: "Auto" } },
      },
    },
  });

  type BuiltProvider = Record<string, {
    name?: string;
    npm?: string;
    options?: { baseURL?: string };
    models?: Record<string, { name?: string }>;
  }>;

  async function setupCursorAcp(options: { cursorApiKey?: string; globalConfig?: string }) {
    const { config } = await setup();
    const globalDir = await mkdtemp(join(tmpdir(), "openwork-cursor-acp-global-"));
    roots.push(globalDir);
    if (options.globalConfig !== undefined) {
      await writeFile(join(globalDir, "opencode.json"), options.globalConfig, "utf8");
    }
    const envPath = join(globalDir, "env.json");
    const previousKey = process.env.CURSOR_API_KEY;
    const previousDir = process.env.OPENCODE_CONFIG_DIR;
    const previousStore = process.env.OPENWORK_ENV_STORE;
    cleanups.push(() => {
      if (previousKey === undefined) delete process.env.CURSOR_API_KEY;
      else process.env.CURSOR_API_KEY = previousKey;
      if (previousDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
      else process.env.OPENCODE_CONFIG_DIR = previousDir;
      if (previousStore === undefined) delete process.env.OPENWORK_ENV_STORE;
      else process.env.OPENWORK_ENV_STORE = previousStore;
    });
    if (options.cursorApiKey === undefined) delete process.env.CURSOR_API_KEY;
    else process.env.CURSOR_API_KEY = options.cursorApiKey;
    process.env.OPENCODE_CONFIG_DIR = globalDir;
    process.env.OPENWORK_ENV_STORE = envPath;
    return { config };
  }

  async function buildParsed(config: ServerConfig): Promise<Record<string, unknown>> {
    return JSON.parse(await buildOpenworkRuntimeConfig(config, "ws_1")) as Record<string, unknown>;
  }

  test("adds cursor-acp plugin and provider from the global config when CURSOR_API_KEY is set", async () => {
    const { config } = await setupCursorAcp({
      cursorApiKey: "cur_test_key",
      globalConfig: GLOBAL_CONFIG_WITH_CURSOR_ACP,
    });

    const parsed = await buildParsed(config);
    expect(parsed.plugin).toContain("cursor-acp");
    const provider = parsed.provider as BuiltProvider;
    expect(provider["cursor-acp"]?.name).toBe("Cursor");
    expect(provider["cursor-acp"]?.npm).toBe("@ai-sdk/openai-compatible");
    expect(provider["cursor-acp"]?.options?.baseURL).toBe("http://127.0.0.1:32124/v1");
    expect(provider["cursor-acp"]?.models?.auto?.name).toBe("Auto");
  });

  test("leaves cursor-acp out when CURSOR_API_KEY is not set", async () => {
    const { config } = await setupCursorAcp({ globalConfig: GLOBAL_CONFIG_WITH_CURSOR_ACP });

    const parsed = await buildParsed(config);
    expect(parsed.plugin).not.toContain("cursor-acp");
    const provider = (parsed.provider ?? {}) as Record<string, unknown>;
    expect(provider["cursor-acp"]).toBeUndefined();
  });

  test("leaves cursor-acp out when the global config has no cursor-acp provider", async () => {
    const { config } = await setupCursorAcp({ cursorApiKey: "cur_test_key", globalConfig: "{}" });

    const parsed = await buildParsed(config);
    expect(parsed.plugin).not.toContain("cursor-acp");
    const provider = (parsed.provider ?? {}) as Record<string, unknown>;
    expect(provider["cursor-acp"]).toBeUndefined();
  });

  test("leaves cursor-acp out when no global config file exists", async () => {
    const { config } = await setupCursorAcp({ cursorApiKey: "cur_test_key" });

    const parsed = await buildParsed(config);
    expect(parsed.plugin).not.toContain("cursor-acp");
    const provider = (parsed.provider ?? {}) as Record<string, unknown>;
    expect(provider["cursor-acp"]).toBeUndefined();
  });

  test("adds cursor-acp from the env store when process.env.CURSOR_API_KEY is unset", async () => {
    const { config } = await setupCursorAcp({ globalConfig: GLOBAL_CONFIG_WITH_CURSOR_ACP });
    const envPath = join(roots[roots.length - 1]!, "env.json");
    const previousStore = process.env.OPENWORK_ENV_STORE;
    cleanups.push(() => {
      if (previousStore === undefined) delete process.env.OPENWORK_ENV_STORE;
      else process.env.OPENWORK_ENV_STORE = previousStore;
    });
    process.env.OPENWORK_ENV_STORE = envPath;
    await new EnvService({ path: envPath }).upsertMany([{ key: "CURSOR_API_KEY", value: "cur_test_key" }]);

    const parsed = await buildParsed(config);
    expect(parsed.plugin).toContain("cursor-acp");
    const provider = parsed.provider as BuiltProvider;
    expect(provider["cursor-acp"]?.options?.baseURL).toBe("http://127.0.0.1:32124/v1");
  });

  test("injects the absolute local plugin path when plugin/cursor-acp.js exists", async () => {
    const { config } = await setupCursorAcp({
      cursorApiKey: "cur_test_key",
      globalConfig: GLOBAL_CONFIG_WITH_CURSOR_ACP,
    });
    const pluginPath = join(process.env.OPENCODE_CONFIG_DIR!, "plugin", "cursor-acp.js");
    await mkdir(join(process.env.OPENCODE_CONFIG_DIR!, "plugin"), { recursive: true });
    await writeFile(pluginPath, "export default async () => ({})", "utf8");

    const parsed = await buildParsed(config);
    expect(parsed.plugin).toContain(pluginPath);
    expect((parsed.plugin as string[]).filter((name) => name === "cursor-acp")).toEqual([]);
    const provider = parsed.provider as BuiltProvider;
    expect(provider["cursor-acp"]?.options?.baseURL).toBe("http://127.0.0.1:32124/v1");
  });

  test("injects cursor-acp from a local plugin file even when CURSOR_API_KEY is unset", async () => {
    const { config } = await setupCursorAcp({ globalConfig: GLOBAL_CONFIG_WITH_CURSOR_ACP });
    const pluginPath = join(process.env.OPENCODE_CONFIG_DIR!, "plugin", "cursor-acp.js");
    await mkdir(join(process.env.OPENCODE_CONFIG_DIR!, "plugin"), { recursive: true });
    await writeFile(pluginPath, "export default async () => ({})", "utf8");

    const parsed = await buildParsed(config);
    expect(parsed.plugin).toContain(pluginPath);
    const provider = parsed.provider as BuiltProvider;
    expect(provider["cursor-acp"]?.name).toBe("Cursor");
  });

  test("runtime-DB cursor-acp provider wins over the global config and the plugin is not duplicated", async () => {
    const { config } = await setupCursorAcp({
      cursorApiKey: "cur_test_key",
      globalConfig: GLOBAL_CONFIG_WITH_CURSOR_ACP,
    });
    await writeRuntimeOpencodeConfig(config, "ws_1", (current) => ({
      ...current,
      plugin: ["cursor-acp"],
      provider: { "cursor-acp": { name: "Runtime Cursor" } },
    }));

    const parsed = await buildParsed(config);
    const plugins = (parsed.plugin as string[]).filter((name) => name === "cursor-acp");
    expect(plugins).toHaveLength(1);
    const provider = parsed.provider as BuiltProvider;
    expect(provider["cursor-acp"]?.name).toBe("Runtime Cursor");
  });
});
