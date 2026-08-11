import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "./server.js";
import type { ReloadEvent, ServerConfig } from "./types.js";

const stops: Array<() => void | Promise<void>> = [];
const roots: string[] = [];

afterEach(async () => {
  while (stops.length) await stops.pop()?.();
  while (roots.length) {
    const root = roots.pop();
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  }
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isReloadEvent(value: unknown): value is ReloadEvent {
  return isRecord(value) && typeof value.reason === "string";
}

function auth(token: string) {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

async function createWorkspaceRoot() {
  const root = await mkdtemp(join(tmpdir(), "openwork-runtime-patch-reload-"));
  roots.push(root);
  return root;
}

async function startOpenworkServer(workspaceRoot: string) {
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    configPath: join(workspaceRoot, "server.json"),
    token: "owt_test_token",
    hostToken: "owt_host_token",
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
  return { base: `http://127.0.0.1:${server.port}`, token: config.token };
}

async function patchConfig(base: string, token: string, payload: Record<string, unknown>): Promise<void> {
  const response = await patchConfigResponse(base, token, payload);
  expect(response.status).toBe(200);
}

async function patchConfigResponse(base: string, token: string, payload: unknown): Promise<Response> {
  return fetch(`${base}/workspace/ws_1/config`, {
    method: "PATCH",
    headers: auth(token),
    body: JSON.stringify(payload),
  });
}

async function readEvents(base: string, token: string): Promise<ReloadEvent[]> {
  const response = await fetch(`${base}/workspace/ws_1/events`, { headers: auth(token) });
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  if (!isRecord(body) || !Array.isArray(body.items)) {
    throw new Error("Expected reload event response");
  }
  return body.items.filter(isReloadEvent);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("workspace config patch reload events", () => {
  test("identical runtime provider patches do not emit another config reload event", async () => {
    const root = await createWorkspaceRoot();
    const { base, token } = await startOpenworkServer(root);
    const payload = {
      opencode: {
        provider: {
          p1: {
            id: "openrouter",
            name: "OpenRouter",
            env: ["OPENROUTER_API_KEY"],
            models: {
              "model-a": { id: "model-a", name: "Model A" },
            },
          },
        },
      },
    };

    await patchConfig(base, token, payload);
    const firstEvents = await readEvents(base, token);
    expect(firstEvents).toHaveLength(1);
    expect(firstEvents[0]?.reason).toBe("config");

    await sleep(800);
    await patchConfig(base, token, payload);

    const secondEvents = await readEvents(base, token);
    expect(secondEvents).toHaveLength(1);
  });

  test("rejects non-object config patch sections", async () => {
    const root = await createWorkspaceRoot();
    const { base, token } = await startOpenworkServer(root);

    const response = await patchConfigResponse(base, token, { opencode: [] });

    expect(response.status).toBe(400);
    const body: unknown = await response.json();
    expect(isRecord(body) ? body.code : null).toBe("invalid_payload");
  });

  test("rejects non-object JSON request bodies", async () => {
    const root = await createWorkspaceRoot();
    const { base, token } = await startOpenworkServer(root);

    const response = await patchConfigResponse(base, token, []);

    expect(response.status).toBe(400);
    const body: unknown = await response.json();
    expect(isRecord(body) ? body.code : null).toBe("invalid_payload");
  });

  test("rejects malformed runtime MCP and plugin config patches", async () => {
    const root = await createWorkspaceRoot();
    const { base, token } = await startOpenworkServer(root);

    const invalidMcp = await patchConfigResponse(base, token, {
      opencode: { mcp: { "-bad": { type: "remote", url: "https://example.com" } } },
    });
    expect(invalidMcp.status).toBe(400);
    const invalidMcpBody: unknown = await invalidMcp.json();
    expect(isRecord(invalidMcpBody) ? invalidMcpBody.code : null).toBe("invalid_mcp_name");

    const invalidPlugin = await patchConfigResponse(base, token, {
      opencode: { plugin: [""] },
    });
    expect(invalidPlugin.status).toBe(400);
    const invalidPluginBody: unknown = await invalidPlugin.json();
    expect(isRecord(invalidPluginBody) ? invalidPluginBody.code : null).toBe("invalid_plugin_spec");
  });

  test("rejects oversized JSON request bodies before parsing", async () => {
    const root = await createWorkspaceRoot();
    const { base, token } = await startOpenworkServer(root);
    const previousLimit = process.env.OPENWORK_JSON_BODY_MAX_BYTES;
    process.env.OPENWORK_JSON_BODY_MAX_BYTES = "16";
    try {
      const response = await patchConfigResponse(base, token, { openwork: { name: "large" } });
      expect(response.status).toBe(413);
      const body: unknown = await response.json();
      expect(isRecord(body) ? body.code : null).toBe("request_too_large");
    } finally {
      if (previousLimit === undefined) {
        delete process.env.OPENWORK_JSON_BODY_MAX_BYTES;
      } else {
        process.env.OPENWORK_JSON_BODY_MAX_BYTES = previousLimit;
      }
    }
  });
});
