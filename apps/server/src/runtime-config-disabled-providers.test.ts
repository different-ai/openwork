import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "./server.js";
import {
  readRuntimeOpencodeConfig,
  writeRuntimeOpencodeConfig,
} from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";

const CLIENT_TOKEN = "owt_runtime_disabled_client";
const HOST_TOKEN = "owt_runtime_disabled_host";
const roots: string[] = [];
const stops: Array<() => void | Promise<void>> = [];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clientAuth() {
  return { authorization: `Bearer ${CLIENT_TOKEN}`, "content-type": "application/json" };
}

async function createTempRoot() {
  const root = await mkdtemp(join(tmpdir(), "openwork-runtime-disabled-providers-"));
  roots.push(root);
  return root;
}

async function startOpenworkServer(workspaceRoot: string) {
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    configPath: join(workspaceRoot, "server.json"),
    token: CLIENT_TOKEN,
    hostToken: HOST_TOKEN,
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [{ id: "ws_1", name: "Workspace", path: workspaceRoot, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [workspaceRoot],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
  const server = await startServer(config);
  stops.push(() => server.stop());
  return { base: `http://127.0.0.1:${server.port}`, config };
}

afterEach(async () => {
  while (stops.length) await stops.pop()?.();
  while (roots.length) {
    const root = roots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("runtime-config disabled providers route", () => {
  test("writes disabled providers into the runtime store", async () => {
    const root = await createTempRoot();
    const { base, config } = await startOpenworkServer(root);

    const response = await fetch(`${base}/workspace/ws_1/runtime-config/disabled-providers`, {
      method: "POST",
      headers: clientAuth(),
      body: JSON.stringify({ providers: ["anthropic", "openai"] }),
    });

    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(isRecord(body) ? body.disabledProviders : null).toEqual(["anthropic", "openai"]);
    expect((await readRuntimeOpencodeConfig(config, "ws_1")).disabled_providers).toEqual(["anthropic", "openai"]);
  });

  test("preserves other runtime keys while updating disabled providers", async () => {
    const root = await createTempRoot();
    const { base, config } = await startOpenworkServer(root);
    await writeRuntimeOpencodeConfig(config, "ws_1", () => ({
      mcp: { notion: { type: "remote", url: "https://notion.example/mcp" } },
      provider: { local: { npm: "@ai-sdk/openai-compatible" } },
    }));

    const response = await fetch(`${base}/workspace/ws_1/runtime-config/disabled-providers`, {
      method: "POST",
      headers: clientAuth(),
      body: JSON.stringify({ providers: ["openai"] }),
    });

    expect(response.status).toBe(200);
    const runtime = await readRuntimeOpencodeConfig(config, "ws_1");
    expect(runtime.disabled_providers).toEqual(["openai"]);
    expect(runtime.mcp?.notion?.url).toBe("https://notion.example/mcp");
    expect(runtime.provider?.local).toEqual({ npm: "@ai-sdk/openai-compatible" });
  });

  test("rejects invalid payloads", async () => {
    const root = await createTempRoot();
    const { base } = await startOpenworkServer(root);

    const response = await fetch(`${base}/workspace/ws_1/runtime-config/disabled-providers`, {
      method: "POST",
      headers: clientAuth(),
      body: JSON.stringify({ providers: ["anthropic", " "] }),
    });

    expect(response.status).toBe(400);
  });
});
