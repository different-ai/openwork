import type { EventEmitter } from "node:events";
import type { PathLike } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { z } from "zod";
import { ApprovalService } from "../src/approvals.js";
import { ReloadEventStore } from "../src/events.js";
import { matchRoute, type Route } from "../src/routes/registry.js";
import { registerWorkspaceRoutes } from "../src/routes/workspaces.js";
import { TokenService } from "../src/tokens.js";
import type { ServerConfig, WorkspaceInfo } from "../src/types.js";
import { UiControlMailbox } from "../src/ui-control.js";

type WatchedDirectory = { path: string; watcher: EventEmitter & { close: ReturnType<typeof vi.fn> } };
const handles = vi.hoisted(() => new Array<WatchedDirectory>());

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const { EventEmitter } = await import("node:events");
  return {
    ...fs,
    watch: vi.fn((path: PathLike, _options: unknown, listener?: (event: string, filename: string | null) => void) => {
      const watcher = Object.assign(new EventEmitter(), {
        close: vi.fn(),
        ref() { return this; },
        unref() { return this; },
      });
      if (listener) watcher.on("change", listener);
      handles.push({ path: path.toString(), watcher });
      return watcher;
    }),
  };
});

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  handles.length = 0;
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "workspace-reload-watcher-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const workspaces: WorkspaceInfo[] = ["first", "second"].map(id => ({
    id, path: join(root, id), name: id, preset: "starter", workspaceType: "local",
  }));
  for (const workspace of workspaces) {
    await mkdir(join(workspace.path, ".opencode", "skills", "nested"), { recursive: true });
  }
  const configPath = join(root, "state", "server.json");
  await mkdir(join(root, "state"));
  await writeFile(configPath, JSON.stringify({ preserved: "fixture-setting" }));
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "fixture-client", hostToken: "fixture-host", configPath,
    trustedDenOrigin: "http://127.0.0.1:1", approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [],
    workspaces, authorizedRoots: workspaces.map(entry => entry.path), readOnly: false,
    startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "json", logRequests: false,
    engineAutoUpgrade: false,
  };
  return { root, config, configPath };
}

async function registeredRoutes() {
  const fixtureState = await fixture();
  const { config } = fixtureState;
  const routes: Route[] = [];
  const onWorkspacesChanged = vi.fn();
  const parseBody = async (request: Request) => {
    const raw = await request.text();
    return z.record(z.string(), z.unknown()).parse(raw ? JSON.parse(raw) : {});
  };
  registerWorkspaceRoutes({
    routes, config, onWorkspacesChanged,
    jsonResponse: (data, status = 200) => Response.json(data, { status }),
    readJsonBody: parseBody, readOptionalJsonBody: parseBody,
    parseOptionalBoolean: value => value === null ? undefined : value === "true",
    ensureWritable: () => { if (config.readOnly) throw new Error("Read only"); },
    resolveWorkspace: async (current, id) => {
      const workspace = current.workspaces.find(entry => entry.id === id);
      if (!workspace) throw new Error(`Unknown workspace: ${id}`);
      return workspace;
    },
    serializeWorkspace: workspace => workspace,
    syncWorkspaceRuntimeMcp: async () => {},
  });
  const approvals = new ApprovalService(config.approval);
  const uiControl = new UiControlMailbox();
  const reloadEvents = new ReloadEventStore();
  const tokens = new TokenService(config);
  const request = async (method: string, path: string, body?: unknown) => {
    const url = new URL(path, "http://127.0.0.1");
    const route = matchRoute(routes, method, url.pathname);
    if (!route) throw new Error(`Missing route: ${method} ${path}`);
    return route.handler({
      request: new Request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
      url, params: route.params, config, approvals, uiControl, reloadEvents, tokens,
    });
  };
  return { ...fixtureState, onWorkspacesChanged, request };
}

test.each(["query", "body"])("persisted activation via %s reorders and persists without notifying watcher changes", async persistSource => {
  const { config, configPath, onWorkspacesChanged, request } = await registeredRoutes();
  const response = persistSource === "query"
    ? await request("POST", "/workspaces/second/activate?persist=true")
    : await request("POST", "/workspaces/second/activate", { persist: true });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ activeId: "second", persisted: true });
  expect(config.workspaces.map(entry => entry.id)).toEqual(["second", "first"]);
  expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
    preserved: "fixture-setting", workspaces: [{ id: "second" }, { id: "first" }],
  });
  expect(onWorkspacesChanged).not.toHaveBeenCalled();
});

test("nonpersisted activation reorders in memory without notifying watcher changes", async () => {
  const { config, configPath, onWorkspacesChanged, request } = await registeredRoutes();
  const before = await readFile(configPath, "utf8");
  const response = await request("POST", "/workspaces/second/activate?persist=false");
  expect(await response.json()).toMatchObject({ activeId: "second", persisted: false });
  expect(config.workspaces.map(entry => entry.id)).toEqual(["second", "first"]);
  expect(await readFile(configPath, "utf8")).toBe(before);
  expect(onWorkspacesChanged).not.toHaveBeenCalled();
});

test("display-name updates are persisted without notifying watcher changes", async () => {
  const { config, configPath, onWorkspacesChanged, request } = await registeredRoutes();
  const response = await request("PATCH", "/workspaces/second/display-name", { displayName: " Renamed " });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ persisted: true });
  expect(config.workspaces.find(entry => entry.id === "second")).toMatchObject({ displayName: "Renamed", name: "Renamed" });
  expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
    workspaces: [{ id: "first" }, { id: "second", displayName: "Renamed", name: "Renamed" }],
  });
  expect(onWorkspacesChanged).not.toHaveBeenCalled();
});

test("creating and deleting local workspaces each notify watcher changes", async () => {
  const { root, config, onWorkspacesChanged, request } = await registeredRoutes();
  const folderPath = join(root, "third");
  const created = await request("POST", "/workspaces/local", { folderPath });
  expect(created.status).toBe(201);
  expect(onWorkspacesChanged).toHaveBeenCalledTimes(1);
  const added = config.workspaces.find(entry => entry.path === folderPath);
  if (!added) throw new Error("Workspace was not created");
  const deleted = await request("DELETE", `/workspaces/${added.id}`);
  expect(deleted.status).toBe(200);
  expect(await deleted.json()).toMatchObject({ deleted: true, persisted: true });
  expect(config.workspaces.some(entry => entry.id === added.id)).toBe(false);
  expect(onWorkspacesChanged).toHaveBeenCalledTimes(2);
});

test("real server activation and rename preserve watchers; create and delete reconcile only the changed workspace", async () => {
  const { root, config, configPath } = await fixture();
  const { startServer } = await import("../src/server.js");
  const server = await startServer(config, { deferManagedEngineStartup: true });
  cleanup.push(() => server.stop());
  const request = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
      method, headers: { "X-OpenWork-Host-Token": config.hostToken, "Content-Type": "application/json", Connection: "close" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000),
    });
    expect(response.status, await response.clone().text()).toBeLessThan(300);
    return response;
  };
  await vi.waitFor(() => expect(handles.filter(entry => entry.path.startsWith(join(root, "first")))).toHaveLength(4));
  await vi.waitFor(() => expect(handles.filter(entry => entry.path.startsWith(join(root, "second")))).toHaveLength(4));
  const initial = [...handles];
  expect(await (await request("POST", "/workspaces/second/activate?persist=true")).json()).toMatchObject({ activeId: "second", persisted: true });
  expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({ workspaces: [{ id: "second" }, { id: "first" }] });
  await request("PATCH", "/workspaces/second/display-name", { displayName: "Renamed" });
  expect(handles).toEqual(initial);
  for (const { watcher } of initial) expect(watcher.close).not.toHaveBeenCalled();
  const folderPath = join(root, "third");
  await request("POST", "/workspaces/local", { folderPath });
  const added = config.workspaces.find(entry => entry.path === folderPath);
  if (!added) throw new Error("Workspace was not created");
  expect(handles.slice(initial.length).some(entry => entry.path === folderPath)).toBe(true);
  for (const { watcher } of initial) expect(watcher.close).not.toHaveBeenCalled();
  await request("DELETE", `/workspaces/${added.id}`);
  for (const { watcher } of handles.slice(initial.length)) expect(watcher.close).toHaveBeenCalledTimes(1);
  for (const { watcher } of initial) expect(watcher.close).not.toHaveBeenCalled();
});
