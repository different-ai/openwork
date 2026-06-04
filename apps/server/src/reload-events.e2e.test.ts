import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "./server.js";
import type { ReloadEvent, ServerConfig } from "./types.js";

type Served = { port: number; stop: (closeActiveConnections?: boolean) => void | Promise<void> };

const stops: Array<() => void | Promise<void>> = [];
const roots: string[] = [];

afterEach(async () => {
  while (stops.length) await stops.pop()?.();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

async function createWorkspaceRoot() {
  const root = await mkdtemp(join(tmpdir(), "openwork-reload-events-"));
  roots.push(root);
  return root;
}

async function startOpenworkServer(workspaceRoot: string) {
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
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
  const server = await startServer(config) as Served;
  stops.push(() => server.stop(true));
  return { base: `http://127.0.0.1:${server.port}`, token: config.token };
}

function auth(token: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function readEvents(base: string, token: string): Promise<ReloadEvent[]> {
  const response = await fetch(`${base}/workspace/ws_1/events`, { headers: auth(token) });
  expect(response.status).toBe(200);
  const body = await response.json() as { items: ReloadEvent[] };
  return body.items;
}

async function waitForEvents(base: string, token: string): Promise<ReloadEvent[]> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const items = await readEvents(base, token);
    if (items.length > 0) return items;
    await sleep(100);
  }
  return readEvents(base, token);
}

describe("reload event API", () => {
  test("does not expose internal workspace bootstrap writes as reload events", async () => {
    const root = await createWorkspaceRoot();
    const { base, token } = await startOpenworkServer(root);

    const configResponse = await fetch(`${base}/workspace/ws_1/config`, { headers: auth(token) });
    expect(configResponse.status).toBe(200);
    await expect(readFile(join(root, "opencode.jsonc"), "utf8")).rejects.toThrow();

    await sleep(1200);
    expect(await readEvents(base, token)).toEqual([]);
  });

  test("does not expose same-content rewrites as reload events", async () => {
    const root = await createWorkspaceRoot();
    const configPath = join(root, "opencode.jsonc");
    const content = '{ "plugin": ["demo"] }\n';
    await writeFile(configPath, content, "utf8");
    const { base, token } = await startOpenworkServer(root);

    const configResponse = await fetch(`${base}/workspace/ws_1/config`, { headers: auth(token) });
    expect(configResponse.status).toBe(200);
    await writeFile(configPath, content, "utf8");

    await sleep(1200);
    expect(await readEvents(base, token)).toEqual([]);
  });

  test("exposes runtime config content changes as reload events", async () => {
    const root = await createWorkspaceRoot();
    const configPath = join(root, "opencode.jsonc");
    await writeFile(configPath, '{ "plugin": ["demo"] }\n', "utf8");
    const { base, token } = await startOpenworkServer(root);

    const configResponse = await fetch(`${base}/workspace/ws_1/config`, { headers: auth(token) });
    expect(configResponse.status).toBe(200);
    await writeFile(configPath, '{ "plugin": ["runtime-change"] }\n', "utf8");

    const items = await waitForEvents(base, token);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ reason: "config", trigger: { name: "opencode.jsonc" } });
  });
});
