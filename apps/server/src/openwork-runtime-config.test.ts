import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

const roots: string[] = [];
const cleanups: Array<() => void> = [];
let previousDb: string | undefined;

afterEach(async () => {
  while (cleanups.length) cleanups.pop()?.();
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
      mcp: { posthog: { type: "remote", url: "https://mcp.posthog.com/mcp", enabled: true } },
    }));

    const path = await writeOpenworkRuntimeConfigFile(config, "ws_1");
    expect(path).toBe(openworkRuntimeConfigFilePath(config));

    const parsed = await readConfigFile(config);
    const mcp = parsed.mcp as Record<string, Record<string, unknown>>;
    expect(mcp.posthog?.enabled).toBe(true);
    expect(parsed.default_agent).toBe("openwork");
    expect(Array.isArray(parsed.plugin)).toBe(true);
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
