import type { EventEmitter } from "node:events";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ReloadEventStore } from "../src/events.js";
import { startReloadWatchers } from "../src/reload-watcher.js";
import type { ReloadReason, ServerConfig, WorkspaceInfo } from "../src/types.js";

type DirectoryEntry = { name: string; isDirectory: () => boolean };
type WatchedDirectory = { path: string; watcher: EventEmitter & { close: ReturnType<typeof vi.fn> } };

const mocks = vi.hoisted(() => ({
  handles: new Array<WatchedDirectory>(),
  exists: vi.fn<(path: string) => boolean>(),
  readDirs: vi.fn<(path: string) => Promise<DirectoryEntry[]>>(),
  fingerprint: vi.fn<(root: string, reason: ReloadReason) => Promise<string>>(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const { EventEmitter } = await import("node:events");
  return {
    ...fs,
    existsSync: mocks.exists,
    watch: vi.fn((path: string, _options: unknown, listener: (event: string, filename: string | null) => void) => {
      const watcher = Object.assign(new EventEmitter(), { close: vi.fn() });
      watcher.on("change", listener);
      mocks.handles.push({ path, watcher });
      return watcher;
    }),
  };
});

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
  readdir: mocks.readDirs,
}));

vi.mock("../src/reload-fingerprint.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/reload-fingerprint.js")>(),
  computeReloadFingerprint: mocks.fingerprint,
}));

const cleanup: Array<() => void> = [];

beforeEach(() => {
  vi.useFakeTimers();
  mocks.handles.length = 0;
  mocks.exists.mockReset().mockReturnValue(true);
  mocks.readDirs.mockReset().mockResolvedValue([]);
  mocks.fingerprint.mockReset().mockResolvedValue("baseline");
});

afterEach(() => {
  for (const close of cleanup.splice(0)) close();
  vi.useRealTimers();
});

function workspace(id: string, path = resolve("watcher-fixture", id)): WorkspaceInfo {
  return { id, path, name: id, preset: "starter", workspaceType: "local" };
}

function start(workspaces = [workspace("first"), workspace("second")]) {
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "fixture", hostToken: "fixture-host",
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces,
    authorizedRoots: [], readOnly: false, startedAt: 0, tokenSource: "generated",
    hostTokenSource: "generated", logFormat: "json", logRequests: false,
  };
  const reloadEvents = new ReloadEventStore();
  const logger = { log: vi.fn() };
  const handle = startReloadWatchers({ config, reloadEvents, logger, debounceMs: 50 });
  cleanup.push(handle.close);
  return { config, handle, reloadEvents, logger };
}

function directories(root: string) {
  return [root, join(root, ".opencode"), ...["skills", "commands", "plugins", "agents", "agent"].map(name => join(root, ".opencode", name))];
}

function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error("Promise not initialized"); };
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test("reordering, renaming and equivalent resolved paths preserve every watcher without logging again", async () => {
  const { config, handle, logger } = start();
  await vi.advanceTimersByTimeAsync(200);
  expect(mocks.handles.map(entry => entry.path).sort()).toEqual(config.workspaces.flatMap(entry => directories(entry.path)).sort());
  const initial = [...mocks.handles];
  config.workspaces = [...config.workspaces].reverse().map(entry => ({ ...entry, name: "Renamed", path: `${entry.path}/nested/..` }));
  handle.sync();
  await vi.advanceTimersByTimeAsync(200);
  expect(mocks.handles).toEqual(initial);
  for (const { watcher } of initial) expect(watcher.close).not.toHaveBeenCalled();
  expect(logger.log).toHaveBeenCalledTimes(1);
});

test.each(["", " \t\n"])("empty or blank workspace path %j is never watched", async path => {
  const { config, handle, logger } = start([workspace("pathless", path)]);
  handle.sync();
  await vi.advanceTimersByTimeAsync(200);
  expect(mocks.handles).toEqual([]);
  expect(mocks.fingerprint).not.toHaveBeenCalled();
  expect(logger.log).not.toHaveBeenCalled();
  const valid = workspace("valid");
  config.workspaces.push(valid);
  handle.sync();
  await vi.advanceTimersByTimeAsync(200);
  expect(mocks.handles.map(entry => entry.path).sort()).toEqual(directories(valid.path).sort());
});

test("duplicate workspace IDs use the same final entry on every sync", async () => {
  const first = workspace("duplicate", resolve("watcher-fixture", "first"));
  const last = workspace("duplicate", resolve("watcher-fixture", "last"));
  const { handle, logger } = start([first, last]);
  await vi.advanceTimersByTimeAsync(200);
  expect(mocks.handles.map(entry => entry.path).sort()).toEqual(directories(last.path).sort());
  const initial = [...mocks.handles];
  for (let attempt = 0; attempt < 3; attempt++) {
    handle.sync();
    await vi.advanceTimersByTimeAsync(200);
  }
  expect(mocks.handles).toEqual(initial);
  for (const { watcher } of initial) expect(watcher.close).not.toHaveBeenCalled();
  expect(logger.log).toHaveBeenCalledExactlyOnceWith("info", "Reload watcher enabled (1)", { workspaceCount: 1 });
});

test("a workspace whose initial watcher startup throws is retried on the next sync", async () => {
  const first = workspace("first");
  mocks.exists.mockImplementationOnce(() => { throw new Error("Temporary startup failure"); });
  const { handle, logger } = start([first]);
  expect(mocks.handles).toEqual([]);
  expect(logger.log).toHaveBeenCalledExactlyOnceWith("warn", "Reload watcher failed to start", {
    workspaceId: first.id, workspacePath: first.path, error: "Temporary startup failure",
  });
  handle.sync();
  await vi.advanceTimersByTimeAsync(200);
  expect(mocks.handles.map(entry => entry.path).sort()).toEqual(directories(first.path).sort());
  const initial = [...mocks.handles];
  handle.sync();
  await vi.advanceTimersByTimeAsync(200);
  expect(mocks.handles).toEqual(initial);
  for (const { watcher } of initial) expect(watcher.close).not.toHaveBeenCalled();
  expect(logger.log).toHaveBeenCalledTimes(2);
});

test("malformed workspace paths warn without preventing valid workspaces from syncing", async () => {
  const malformed = workspace("malformed");
  Reflect.set(malformed, "path", 42);
  const valid = workspace("valid");
  const { handle, logger } = start([malformed, valid]);
  await vi.advanceTimersByTimeAsync(200);
  expect(mocks.handles.map(entry => entry.path).sort()).toEqual(directories(valid.path).sort());
  expect(logger.log).toHaveBeenCalledWith("warn", "Reload watcher failed to start", expect.objectContaining({
    workspaceId: malformed.id, workspacePath: 42, error: expect.any(String),
  }));
  const initial = [...mocks.handles];
  expect(() => handle.sync()).not.toThrow();
  await vi.advanceTimersByTimeAsync(200);
  expect(mocks.handles).toEqual(initial);
  for (const { watcher } of initial) expect(watcher.close).not.toHaveBeenCalled();
});

test("adding a workspace starts only its watchers and preserves existing watchers", async () => {
  const { config, handle, logger } = start();
  await vi.advanceTimersByTimeAsync(200);
  const initial = [...mocks.handles];
  const added = workspace("third");
  config.workspaces.push(added);
  handle.sync();
  await vi.advanceTimersByTimeAsync(200);
  expect(mocks.handles.slice(initial.length).map(entry => entry.path).sort()).toEqual(directories(added.path).sort());
  for (const { watcher } of initial) expect(watcher.close).not.toHaveBeenCalled();
  expect(logger.log).toHaveBeenLastCalledWith("info", "Reload watcher enabled (3)", { workspaceCount: 3 });
});

test("removing a workspace closes only its watchers and keeps the remaining baseline refreshable", async () => {
  const first = workspace("first");
  const second = workspace("second");
  const { config, handle, logger } = start([first, second]);
  await vi.advanceTimersByTimeAsync(200);
  const initial = [...mocks.handles];
  config.workspaces = [second];
  handle.sync();
  await vi.advanceTimersByTimeAsync(200);
  expect(mocks.handles).toEqual(initial);
  for (const { path, watcher } of initial) expect(watcher.close).toHaveBeenCalledTimes(path.startsWith(first.path) ? 1 : 0);
  mocks.fingerprint.mockClear();
  await handle.refreshWorkspace(first.id);
  expect(mocks.fingerprint).not.toHaveBeenCalled();
  await handle.refreshWorkspace(second.id, ["skills"]);
  expect(mocks.fingerprint).toHaveBeenCalledExactlyOnceWith(second.path, "skills");
  expect(logger.log).toHaveBeenCalledTimes(1);
});

test("changing a workspace path replaces only that workspace's watchers", async () => {
  const first = workspace("first");
  const second = workspace("second");
  const { config, handle } = start([first, second]);
  await vi.advanceTimersByTimeAsync(200);
  const initial = [...mocks.handles];
  const moved = { ...first, path: resolve("watcher-fixture", "moved") };
  config.workspaces = [moved, second];
  handle.sync();
  await vi.advanceTimersByTimeAsync(200);
  for (const { path, watcher } of initial) expect(watcher.close).toHaveBeenCalledTimes(path.startsWith(first.path) ? 1 : 0);
  expect(mocks.handles.slice(initial.length).map(entry => entry.path).sort()).toEqual(directories(moved.path).sort());
  mocks.fingerprint.mockClear();
  await handle.refreshWorkspace(first.id, ["config"]);
  expect(mocks.fingerprint).toHaveBeenCalledExactlyOnceWith(moved.path, "config");
});

test("closing during a directory scan never creates orphaned watchers", async () => {
  const scan = deferred<DirectoryEntry[]>();
  mocks.readDirs.mockReturnValue(scan.promise);
  const { handle } = start([workspace("first")]);
  await vi.advanceTimersByTimeAsync(200);
  expect(mocks.readDirs).toHaveBeenCalledTimes(5);
  expect(mocks.handles).toHaveLength(2);
  handle.close();
  scan.resolve([{ name: "nested", isDirectory: () => true }]);
  mocks.readDirs.mockResolvedValue([]);
  await vi.advanceTimersByTimeAsync(1000);
  expect(mocks.handles).toHaveLength(2);
  for (const { watcher } of mocks.handles) expect(watcher.close).toHaveBeenCalledTimes(1);
});

test("closed handles ignore late root, opencode and tree callbacks and cannot be synced back to life", async () => {
  const { config, handle, reloadEvents, logger } = start([workspace("first")]);
  await vi.advanceTimersByTimeAsync(200);
  const initial = [...mocks.handles];
  handle.close();
  mocks.fingerprint.mockClear();
  mocks.readDirs.mockClear();
  logger.log.mockClear();
  for (const { watcher } of initial) {
    for (const filename of [".opencode", "opencode.json", "SKILL.md", null]) watcher.emit("change", "rename", filename);
    watcher.emit("error", new Error("late event"));
  }
  config.workspaces.push(workspace("late"));
  handle.sync();
  await handle.refreshWorkspace("first");
  await vi.advanceTimersByTimeAsync(1000);
  expect(mocks.handles).toEqual(initial);
  expect(mocks.fingerprint).not.toHaveBeenCalled();
  expect(mocks.readDirs).not.toHaveBeenCalled();
  expect(logger.log).not.toHaveBeenCalled();
  expect(reloadEvents.cursor()).toBe(0);
});

test("closing during baseline initialization stops subsequent fingerprint reads", async () => {
  const fingerprint = deferred<string>();
  mocks.fingerprint.mockReturnValue(fingerprint.promise);
  const { handle } = start([workspace("first")]);
  expect(mocks.fingerprint).toHaveBeenCalledTimes(1);
  handle.close();
  fingerprint.resolve("baseline");
  await vi.advanceTimersByTimeAsync(1000);
  expect(mocks.fingerprint).toHaveBeenCalledTimes(1);
});

test("closing during an explicit baseline refresh stops subsequent fingerprint reads", async () => {
  const { handle } = start([workspace("first")]);
  await vi.advanceTimersByTimeAsync(200);
  const fingerprint = deferred<string>();
  mocks.fingerprint.mockReset().mockReturnValue(fingerprint.promise);
  const refresh = handle.refreshWorkspace("first", ["config", "skills"]);
  handle.close();
  fingerprint.resolve("refreshed");
  await refresh;
  expect(mocks.fingerprint).toHaveBeenCalledTimes(1);
});

test("a fingerprint check finishing after close cannot publish a reload event", async () => {
  const first = workspace("first");
  const { handle, reloadEvents } = start([first]);
  await vi.advanceTimersByTimeAsync(200);
  const fingerprint = deferred<string>();
  mocks.fingerprint.mockReset().mockReturnValue(fingerprint.promise);
  const root = mocks.handles.find(entry => entry.path === first.path);
  expect(root).toBeDefined();
  root?.watcher.emit("change", "change", "opencode.json");
  await vi.advanceTimersByTimeAsync(50);
  expect(mocks.fingerprint).toHaveBeenCalledExactlyOnceWith(first.path, "config");
  handle.close();
  fingerprint.resolve("changed");
  await vi.advanceTimersByTimeAsync(1000);
  expect(reloadEvents.cursor()).toBe(0);
});

test("unchanged watchers continue detecting fingerprint changes after sync", async () => {
  const first = workspace("first");
  const { config, handle, reloadEvents } = start([first, workspace("second")]);
  await vi.advanceTimersByTimeAsync(200);
  config.workspaces.reverse();
  handle.sync();
  mocks.fingerprint.mockResolvedValue("changed");
  const root = mocks.handles.find(entry => entry.path === first.path);
  root?.watcher.emit("change", "change", "opencode.json");
  await vi.advanceTimersByTimeAsync(50);
  expect(reloadEvents.list(first.id)).toEqual([expect.objectContaining({ workspaceId: first.id, reason: "config" })]);
});
