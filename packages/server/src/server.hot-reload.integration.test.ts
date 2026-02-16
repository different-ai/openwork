import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createOpencodeReloader, createServerLogger, shouldReloadOpencode, startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

type Harness = {
  workspaceId: string;
  workspacePath: string;
  token: string;
  baseUrl: string;
  config: ServerConfig;
  server: ReturnType<typeof startServer> & { stop?: (closeActiveConnections?: boolean) => void };
  fake: {
    baseUrl: string;
    getDisposeCount: () => number;
    server: { stop?: (closeActiveConnections?: boolean) => void; port: number };
  };
};

const harnesses: Harness[] = [];

afterEach(async () => {
  while (harnesses.length) {
    const harness = harnesses.pop();
    if (!harness) continue;
    try {
      (harness.server as any).reloadWatcher?.close?.();
    } catch {
      // ignore
    }
    try {
      harness.server.stop?.(true);
    } catch {
      // ignore
    }
    try {
      harness.fake.server.stop?.(true);
    } catch {
      // ignore
    }
    await rm(harness.workspacePath, { recursive: true, force: true });
  }
});

async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not resolve free port"));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 8_000, pollMs = 50): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

async function listDirNames(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

async function listCommandNames(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
      .map((entry) => entry.name.replace(/\.md$/i, ""))
      .sort();
  } catch {
    return [];
  }
}

async function createFakeOpencode(workspacePath: string): Promise<Harness["fake"]> {
  let disposeCount = 0;
  let loadedSkills: string[] = [];
  let loadedCommands: string[] = [];

  const refresh = async () => {
    loadedSkills = await listDirNames(join(workspacePath, ".opencode", "skills"));
    loadedCommands = await listCommandNames(join(workspacePath, ".opencode", "commands"));
  };

  await refresh();

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: await freePort(),
    fetch: async (request) => {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") {
        return Response.json({ healthy: true });
      }

      if (request.method === "POST" && url.pathname === "/global/dispose") {
        disposeCount += 1;
        await refresh();
        return Response.json(true);
      }

      if (request.method === "GET" && url.pathname === "/command") {
        const commands = loadedCommands.map((name) => ({
          name,
          description: `command ${name}`,
          source: "command",
          template: `template ${name}`,
          hints: [],
        }));
        const skills = loadedSkills.map((name) => ({
          name,
          description: `skill ${name}`,
          source: "skill",
          template: `template ${name}`,
          hints: [],
        }));
        return Response.json([...commands, ...skills]);
      }

      return Response.json({ code: "not_found" }, { status: 404 });
    },
  });

  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    getDisposeCount: () => disposeCount,
    server,
  };
}

async function createHarness(hotReloadEnabled = true): Promise<Harness> {
  const workspacePath = await mkdtemp(join(tmpdir(), "openwork-hot-reload-"));
  const workspaceId = "ws_test";
  const token = "test-client-token";
  const hostToken = "test-host-token";

  await mkdir(join(workspacePath, ".opencode", "skills"), { recursive: true });
  await mkdir(join(workspacePath, ".opencode", "commands"), { recursive: true });
  await mkdir(join(workspacePath, ".opencode", "agents"), { recursive: true });
  await writeFile(join(workspacePath, "opencode.json"), "{}\n", "utf8");

  const fake = await createFakeOpencode(workspacePath);

  const config: ServerConfig = {
    host: "127.0.0.1",
    port: await freePort(),
    token,
    hostToken,
    approval: { mode: "auto", timeoutMs: 30_000 },
    corsOrigins: ["*"],
    workspaces: [
      {
        id: workspaceId,
        name: "workspace",
        path: workspacePath,
        workspaceType: "local",
        baseUrl: fake.baseUrl,
        directory: workspacePath,
        opencode: {
          baseUrl: fake.baseUrl,
          directory: workspacePath,
        },
      },
    ],
    authorizedRoots: [workspacePath],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
    hotReload: {
      enabled: hotReloadEnabled,
      debounceMs: 50,
    },
  };

  const server = startServer(config);
  const harness: Harness = {
    workspaceId,
    workspacePath,
    token,
    baseUrl: `http://127.0.0.1:${server.port}`,
    config,
    server,
    fake,
  };
  harnesses.push(harness);
  return harness;
}

async function requestJson<T>(harness: Harness, path: string, options?: { method?: string; body?: unknown }): Promise<T> {
  const response = await fetch(`${harness.baseUrl}${path}`, {
    method: options?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${harness.token}`,
      ...(options?.body ? { "Content-Type": "application/json" } : {}),
    },
    body: options?.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${text}`);
  }
  if (!text) return {} as T;
  return JSON.parse(text) as T;
}

describe("hot reload without orchestrator restart", () => {
  test("reload mapping covers agents mcp plugins and commands", () => {
    expect(shouldReloadOpencode("agents")).toBeTrue();
    expect(shouldReloadOpencode("mcp")).toBeTrue();
    expect(shouldReloadOpencode("plugins")).toBeTrue();
    expect(shouldReloadOpencode("commands")).toBeTrue();
  });

  test("skills and commands become active immediately", async () => {
    const harness = await createHarness(true);

    await requestJson(harness, `/workspace/${harness.workspaceId}/skills`, {
      method: "POST",
      body: {
        name: "skill-hot-proof",
        content:
          "---\nname: skill-hot-proof\ndescription: test skill\n---\n\n## When to use\n- use this skill for tests\n\n## What to do\n- reply with SKILL_OK\n",
      },
    });

    await waitFor(async () => {
      const items = await requestJson<Array<{ name: string }>>(harness, `/w/${harness.workspaceId}/opencode/command`);
      return items.some((item) => item.name === "skill-hot-proof") && harness.fake.getDisposeCount() >= 1;
    });

    await requestJson(harness, `/workspace/${harness.workspaceId}/commands`, {
      method: "POST",
      body: {
        name: "command-hot-proof",
        template: "say hi",
      },
    });

    await waitFor(async () => {
      const items = await requestJson<Array<{ name: string }>>(harness, `/w/${harness.workspaceId}/opencode/command`);
      return items.some((item) => item.name === "command-hot-proof") && harness.fake.getDisposeCount() >= 2;
    });
  });

  test("plugins and mcp updates request OpenCode reload", async () => {
    const harness = await createHarness(true);
    const before = harness.fake.getDisposeCount();

    await requestJson(harness, `/workspace/${harness.workspaceId}/plugins`, {
      method: "POST",
      body: { spec: "github.com/different-ai/plugin-proof" },
    });

    await waitFor(async () => harness.fake.getDisposeCount() > before);
    const afterPlugin = harness.fake.getDisposeCount();

    await requestJson(harness, `/workspace/${harness.workspaceId}/mcp`, {
      method: "POST",
      body: {
        name: "proof-mcp",
        config: { type: "local", command: ["node", "mcp-proof.js"] },
      },
    });

    await waitFor(async () => harness.fake.getDisposeCount() > afterPlugin);

    const events = await requestJson<{ items: Array<{ reason: string }> }>(
      harness,
      `/workspace/${harness.workspaceId}/events?since=0`,
    );
    const reasons = new Set(events.items.map((item) => item.reason));
    expect(reasons.has("plugins")).toBeTrue();
    expect(reasons.has("mcp")).toBeTrue();
  });

  test("agent events trigger OpenCode reload requests", async () => {
    const harness = await createHarness(true);
    const before = harness.fake.getDisposeCount();

    const reloader = createOpencodeReloader(harness.config, createServerLogger(harness.config));
    reloader({ workspaceId: harness.workspaceId, reason: "agents" });

    await waitFor(async () => harness.fake.getDisposeCount() > before);
  });

  test("disabled hot reload never requests OpenCode reload", async () => {
    const harness = await createHarness(false);

    await requestJson(harness, `/workspace/${harness.workspaceId}/commands`, {
      method: "POST",
      body: {
        name: "disabled-hot-reload-command",
        template: "noop",
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(harness.fake.getDisposeCount()).toBe(0);

    const events = await requestJson<{ disabled: boolean; items: unknown[] }>(
      harness,
      `/workspace/${harness.workspaceId}/events?since=0`,
    );
    expect(events.disabled).toBeTrue();
    expect(events.items.length).toBe(0);
  });
});
