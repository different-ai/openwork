import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createLocalHost, killLocalPid, removeOwnedSurfaceFiles } from "@openwork/hosts";
import type { DisposableHost, SurfaceHandle } from "@openwork/hosts";
import { cleanupAppWeb } from "./app-web.ts";

const roots: string[] = [];
const hosts: DisposableHost[] = [];
const previousChrome = process.env.CHROME_BIN;
const previousLogs = process.env.OPENWORK_EVAL_SURFACE_LOGS_DIR;

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop();
  if (previousChrome === undefined) delete process.env.CHROME_BIN;
  else process.env.CHROME_BIN = previousChrome;
  if (previousLogs === undefined) delete process.env.OPENWORK_EVAL_SURFACE_LOGS_DIR;
  else process.env.OPENWORK_EVAL_SURFACE_LOGS_DIR = previousLogs;
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "openwork-profile-cleanup-"));
  roots.push(root);
  // A real detached process with only the Chrome host's HTTP readiness protocol.
  // This exercises ownership and process checks without launching a UI or engine.
  const binary = join(root, "chrome.mjs");
  await writeFile(binary, `#!${process.execPath}
import { createServer } from 'node:http';
const port = Number(process.argv.find(arg => arg.startsWith('--remote-debugging-port=')).split('=')[1]);
createServer((request, response) => { response.setHeader('Content-Type', 'application/json'); response.end('[]'); }).listen(port, '127.0.0.1');
console.log('owned browser log');
`);
  await chmod(binary, 0o755);
  process.env.CHROME_BIN = binary;
  delete process.env.OPENWORK_EVAL_SURFACE_LOGS_DIR;
  const host = createLocalHost({ repoRoot: root, rootDir: join(root, "surfaces"), log: () => undefined });
  hosts.push(host);
  const handle = await host.spawnChrome("final-fixture", { headless: true });
  if (!handle.profileDir || !handle.meta?.log || !handle.meta.profileRoot || !handle.pid) throw new Error("Missing launch receipt");
  const profileDir = handle.profileDir;
  const profileRoot = handle.meta.profileRoot;
  const log = handle.meta.log;
  const data = join(profileDir, "sentinel");
  await writeFile(data, "owned cache");
  const report = join(root, "test-runs", "test-run.json");
  await mkdir(join(root, "test-runs"));
  await writeFile(report, '{"status":"passed"}');
  return { root, host, handle, profileDir, profileRoot, log, data, report };
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, () => false);
}

async function finalize(host: DisposableHost, handle: SurfaceHandle): Promise<void> {
  await cleanupAppWeb({ browserStop: () => host.disposeSurface(handle), browserHandle: handle, runtime: null, mocks: {}, remote: false });
}

test("only final app-web teardown removes owned stopped Chrome data, keeping logs and reports", async () => {
  const { root, host, handle, profileDir, profileRoot, log, report } = await fixture();
  const logs = join(root, "kept-logs");
  const unrelated = join(root, "surfaces", "unowned-profile", "chrome-profile");
  await mkdir(unrelated, { recursive: true });
  await writeFile(join(unrelated, "sentinel"), "unrelated cache");
  process.env.OPENWORK_EVAL_SURFACE_LOGS_DIR = logs;
  await finalize(host, handle);
  expect(await readFile(join(unrelated, "sentinel"), "utf8")).toBe("unrelated cache");
  expect(await exists(profileDir)).toBe(false);
  expect(await readFile(log, "utf8")).toContain("owned browser log");
  expect(await readFile(join(logs, `${profileRoot.split(/[\\/]/).at(-1)}-chrome.log`), "utf8")).toContain("owned browser log");
  expect(await readFile(report, "utf8")).toBe('{"status":"passed"}');
});

test("final Chrome file release removes stopped owned data without deleting evidence", async () => {
  const { host, handle, profileDir, log, report } = await fixture();
  await host.disposeSurface(handle);
  await removeOwnedSurfaceFiles(handle, { stoppedChrome: true });
  expect(await exists(profileDir)).toBe(false);
  expect(await readFile(log, "utf8")).toContain("owned browser log");
  expect(await readFile(report, "utf8")).toBe('{"status":"passed"}');
});

test("ordinary host stop retains Chrome profile data for restart or reattachment", async () => {
  const { host, handle, data } = await fixture();
  await host.disposeSurface(handle);
  expect(await readFile(data, "utf8")).toBe("owned cache");
});

test("an active or never-disposed launch cannot release its profile", async () => {
  const { host, handle, data } = await fixture();
  await expect(removeOwnedSurfaceFiles(handle, { stoppedChrome: true })).rejects.toThrow("stop is unconfirmed or still active");
  expect(await readFile(data, "utf8")).toBe("owned cache");
  // A dead process alone is not a successful owning-host disposal receipt.
  if (!handle.pid) throw new Error("Missing pid");
  await killLocalPid(handle.pid);
  await expect(removeOwnedSurfaceFiles(handle, { stoppedChrome: true })).rejects.toThrow("stop is unconfirmed");
  expect(await readFile(data, "utf8")).toBe("owned cache");
  await host.disposeSurface(handle);
});

test("unowned, caller-owned, wrong-kind and mutated handles cannot delete files", async () => {
  const { host, handle, data } = await fixture();
  await host.disposeSurface(handle);
  await expect(removeOwnedSurfaceFiles({ ...handle }, { stoppedChrome: true })).rejects.toThrow("ownership or scope mismatch");
  const original = { kind: handle.kind, hostKind: handle.hostKind, pid: handle.pid, profileDir: handle.profileDir, meta: handle.meta };
  const mutations: Partial<SurfaceHandle>[] = [
    { kind: "electron" }, { hostKind: "daytona" }, { pid: process.pid },
    { profileDir: join(data, "..", "unrelated") },
    { meta: { ...handle.meta, profileOwner: "caller" } },
    { meta: { ...handle.meta, profileRoot: join(data, "..") } },
  ];
  for (const mutation of mutations) {
    Object.assign(handle, mutation);
    await expect(removeOwnedSurfaceFiles(handle, { stoppedChrome: true })).rejects.toThrow("ownership or scope mismatch");
    Object.assign(handle, original);
    expect(await readFile(data, "utf8")).toBe("owned cache");
  }
});

test("replaced directories and symlinks fail closed even at the original owned path", async () => {
  const { host, handle, profileDir, data } = await fixture();
  await host.disposeSurface(handle);
  const moved = `${profileDir}-moved`;
  await rename(profileDir, moved);
  await mkdir(profileDir);
  await writeFile(join(profileDir, "sentinel"), "replacement cache");
  await expect(removeOwnedSurfaceFiles(handle, { stoppedChrome: true })).rejects.toThrow("identity or scope mismatch");
  await rm(profileDir, { recursive: true });
  await symlink(moved, profileDir, "dir");
  await expect(removeOwnedSurfaceFiles(handle, { stoppedChrome: true })).rejects.toThrow("identity or scope mismatch");
  expect(await readFile(data, "utf8")).toBe("owned cache");
});

test("a mismatched on-disk process receipt preserves the owned directory", async () => {
  const { host, handle, profileDir, data } = await fixture();
  await host.disposeSurface(handle);
  await writeFile(join(profileDir, "openwork-eval-chrome.pid"), String(process.pid));
  await expect(removeOwnedSurfaceFiles(handle, { stoppedChrome: true })).rejects.toThrow("identity or scope mismatch");
  expect(await readFile(data, "utf8")).toBe("owned cache");
});

test("a profile in use by another process is preserved after the owning browser stops", async () => {
  const { host, handle, data } = await fixture();
  await host.disposeSurface(handle);
  const holder = spawn(process.execPath, ["-e", `require('node:fs').openSync(process.argv[1], 'r'); console.log('ready'); setInterval(() => {}, 1000);`, data], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    await once(holder.stdout, "data");
    await expect(removeOwnedSurfaceFiles(handle, { stoppedChrome: true })).rejects.toThrow("open files remain");
    expect(await readFile(data, "utf8")).toBe("owned cache");
  } finally {
    const exited = once(holder, "exit");
    holder.kill();
    await exited;
  }
});

test("an unreadable descendant with a held file preserves the entire stopped profile", async () => {
  const { host, handle, profileDir } = await fixture();
  await host.disposeSurface(handle);
  const descendant = join(profileDir, "unreadable");
  await mkdir(descendant);
  const heldFile = join(descendant, "held-cache");
  await writeFile(heldFile, "still in use");
  const snapshot = async (path: string): Promise<string[]> => {
    const entries = (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    const contents: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        contents.push(`${entry.name}/`, ...(await snapshot(join(path, entry.name))).map(value => `${entry.name}/${value}`));
      } else {
        contents.push(`${entry.name}:${(await readFile(join(path, entry.name))).toString("base64")}`);
      }
    }
    return contents;
  };
  const before = await snapshot(profileDir);
  const holder = spawn(process.execPath, ["-e", `require('node:fs').openSync(process.argv[1], 'r'); console.log('ready'); setInterval(() => {}, 1000);`, heldFile], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    await once(holder.stdout, "data", { signal: AbortSignal.timeout(5_000) });
    await chmod(descendant, 0);
    // Prove that this real filesystem/process probe cannot inspect the subtree.
    // An exit status alone is not a complete no-open-files witness.
    await expect(readdir(descendant)).rejects.toMatchObject({ code: "EACCES" });
    const inspected = await new Promise<{ code: string | number; stdout: string; stderr: string }>(done => {
      execFile("lsof", ["+w", "+D", profileDir], { encoding: "utf8", timeout: 5_000 }, (error, stdout, stderr) => {
        done({ code: error?.code ?? 0, stdout, stderr });
      });
    });
    expect(inspected.code).toBe(1);
    expect(inspected.stdout.trim()).toBe("");
    expect(inspected.stderr).toMatch(/permission denied|can't (?:stat|open)|cannot (?:access|open)/i);
    let failure: unknown;
    try { await removeOwnedSurfaceFiles(handle, { stoppedChrome: true }); } catch (error) { failure = error; }
    await chmod(descendant, 0o700);
    // Compare every directory and file, not only the inaccessible held file:
    // recursive rm can otherwise delete accessible siblings before it fails.
    expect(await snapshot(profileDir)).toEqual(before);
    expect(failure).toMatchObject({ message: "Refusing Chrome profile cleanup: open files remain or the open-file check failed." });
  } finally {
    try {
      await chmod(descendant, 0o700);
    } finally {
      const exited = once(holder, "exit");
      holder.kill();
      await exited;
    }
  }
});

test("failed browser stop preserves profile and still tears down the other fixture resources", async () => {
  const { root, handle, data } = await fixture();
  const runtimeDirectory = join(root, "runtime");
  const fixtureRoot = join(root, "fixture");
  await mkdir(runtimeDirectory);
  await mkdir(fixtureRoot);
  let runtimeStopped = false;
  await expect(cleanupAppWeb({
    browserStop: async () => { throw new Error("stop failed"); }, browserHandle: handle,
    runtime: { runtimeDirectory, fixtureRoot, webUrl: "", openworkUrl: "", source: null, stop: async () => { runtimeStopped = true; } },
    mocks: {}, remote: false,
  })).rejects.toThrow("Hermetic app-web cleanup failed");
  expect(runtimeStopped).toBe(true);
  expect(await exists(runtimeDirectory)).toBe(false);
  expect(await exists(fixtureRoot)).toBe(false);
  expect(await readFile(data, "utf8")).toBe("owned cache");
});

test("a stop callback that reports success without host disposal cannot remove the profile", async () => {
  const { handle, data } = await fixture();
  await expect(cleanupAppWeb({ browserStop: async () => undefined, browserHandle: handle, runtime: null, mocks: {}, remote: false }))
    .rejects.toThrow("Hermetic app-web cleanup failed");
  expect(await readFile(data, "utf8")).toBe("owned cache");
});

test("failed open-file inspection and an open file in this process both preserve data", async () => {
  const { host, handle, data } = await fixture();
  await host.disposeSurface(handle);
  const file = await open(data, "r");
  try {
    await expect(removeOwnedSurfaceFiles(handle, { stoppedChrome: true })).rejects.toThrow("open files remain");
    expect(await readFile(data, "utf8")).toBe("owned cache");
  } finally {
    await file.close();
  }
  const path = process.env.PATH;
  process.env.PATH = "/nonexistent-openwork-profile-test-path";
  try {
    await expect(removeOwnedSurfaceFiles(handle, { stoppedChrome: true })).rejects.toThrow("open-file check failed");
    expect(await readFile(data, "utf8")).toBe("owned cache");
  } finally {
    process.env.PATH = path;
  }
});
