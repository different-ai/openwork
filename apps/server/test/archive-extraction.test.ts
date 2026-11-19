import assert from "node:assert/strict";
import { ChildProcess, type SpawnOptions } from "node:child_process";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { extractArchive } from "../src/selfhost-web.js";

const cwd = join(tmpdir(), "archive extraction");
const archive = join(cwd, "deps.tgz");
const destination = join(cwd, "staging", "deps");

test("extraction yields the event loop and waits for close, not exit", async () => {
  const child = new ChildProcess();
  let settled = false;
  let ticks = 0;
  const heartbeat = setInterval(() => { ticks += 1; }, 1);
  try {
    const pending = extractArchive(archive, "deps.tgz", destination, {
      spawnImpl(command, args, options) {
        assert.match(command, /tar(?:\.exe)?$/);
        assert.deepEqual(args, ["-xf", "deps.tgz", "-C", relative(cwd, destination)]);
        assert.deepEqual(options, { cwd, windowsHide: true, stdio: ["ignore", "ignore", "inherit"] });
        return child;
      },
    }).then(() => { settled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    child.emit("exit", 0, null);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    assert.equal(settled, false);
    assert.ok(ticks > 0, "main-thread heartbeat must run while extraction is pending");
    child.emit("close", 0, null);
    await pending;
    assert.equal(settled, true);
  } finally {
    clearInterval(heartbeat);
    child.emit("close", 0, null);
  }
});

test("extraction rejects non-zero exit and signal termination", async () => {
  for (const [code, signal] of [[2, null], [null, "SIGTERM"]]) {
    const child = new ChildProcess();
    const pending = extractArchive(archive, "deps.tgz", destination, { spawnImpl: () => child });
    const rejected = assert.rejects(pending, /exited with (2|SIGTERM) while extracting deps.tgz/);
    child.emit("close", code, signal);
    await rejected;
  }
});

test("extraction rejects asynchronous and synchronous spawn errors", async () => {
  const error = new Error("spawn failed");
  const child = new ChildProcess();
  const pending = extractArchive(archive, "deps.tgz", destination, { spawnImpl: () => child });
  const rejected = assert.rejects(pending, error);
  child.emit("error", error);
  child.emit("close", -2, null);
  await rejected;
  await assert.rejects(extractArchive(archive, "deps.tgz", destination, {
    spawnImpl() { throw error; },
  }), error);
});

test("timeout kills extraction and waits for close before fallback can start", async () => {
  const child = new ChildProcess();
  let settled = false;
  let killed: NodeJS.Signals | number | undefined;
  let onKill: (() => void) | undefined;
  const killRequested = new Promise<void>((resolve) => { onKill = resolve; });
  child.kill = (signal) => {
    killed = signal;
    onKill?.();
    return true;
  };
  const pending = extractArchive(archive, "deps.tgz", destination, {
    spawnImpl: () => child, timeoutMs: 10,
  });
  const rejected = assert.rejects(pending, /timed out after 10 ms/).then(() => { settled = true; });
  await killRequested;
  assert.equal(killed, "SIGKILL");
  assert.equal(settled, false);
  child.emit("close", null, "SIGKILL");
  await rejected;
  assert.equal(settled, true);
});

test("successful close clears timeout without killing the completed process", async () => {
  const child = new ChildProcess();
  let kills = 0;
  child.kill = () => { kills += 1; return true; };
  const pending = extractArchive(archive, "deps.tgz", destination, { spawnImpl: () => child, timeoutMs: 1 });
  child.emit("close", 0, null);
  await pending;
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  assert.equal(kills, 0);
});

test("zip extraction keeps unzip arguments on POSIX and relative tar arguments on Windows", async () => {
  const child = new ChildProcess();
  let received: SpawnOptions | undefined;
  const pending = extractArchive(join(cwd, "engine.zip"), "engine.zip", destination, {
    spawnImpl(command, args, options) {
      received = options;
      if (process.platform === "win32") {
        assert.match(command, /tar(?:\.exe)?$/);
        assert.deepEqual(args, ["-xf", "engine.zip", "-C", relative(cwd, destination)]);
      } else {
        assert.equal(command, "unzip");
        assert.deepEqual(args, ["-q", join(cwd, "engine.zip"), "-d", destination]);
      }
      return child;
    },
  });
  child.emit("close", 0, null);
  await pending;
  assert.equal(received?.cwd, cwd);
});
