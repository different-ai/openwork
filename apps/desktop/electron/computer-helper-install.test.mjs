import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { installComputerHelper } from "./computer-helper-install.mjs";
import { createLocalComputerAdapter } from "./computer-local.mjs";

const helperName = "OpenWork Computer Use.app";
const executable = path.join("Contents", "MacOS", "ComputerUse");

/** @param {(context: { helpersRoot: string, directory: string, binary: string, installed: string, copies: string[][], exec: (file: string, args: string[]) => Promise<void> }) => Promise<void>} run */
async function withHelper(run) {
  const root = await mkdtemp(path.join(tmpdir(), "openwork-helper-install-"));
  try {
    const helpersRoot = path.join(root, "OpenWork.app", "Contents", "Resources", "helpers");
    const directory = path.join(root, "user-data", "computer-use");
    const binary = path.join(helpersRoot, helperName, executable);
    await mkdir(path.dirname(binary), { recursive: true });
    await writeFile(binary, "helper v1");
    await writeFile(path.join(helpersRoot, helperName, "Contents", "Info.plist"), "plist");
    /** @type {string[][]} */
    const copies = [];
    const exec = async (/** @type {string} */ file, /** @type {string[]} */ args) => {
      copies.push([file, ...args]);
      await cp(args[1], args[2], { recursive: true });
    };
    await run({ helpersRoot, directory, binary, installed: path.join(directory, helperName, executable), copies, exec });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("runs a copy of the bundled helper from outside the app", async () => {
  await withHelper(async ({ helpersRoot, directory, binary, installed, copies, exec }) => {
    assert.equal(await installComputerHelper(binary, { helpersRoot, directory, exec }), installed);
    assert.equal(await readFile(installed, "utf8"), "helper v1");
    assert.equal(await readFile(path.join(directory, helperName, "Contents", "Info.plist"), "utf8"), "plist");
    assert.deepEqual(copies[0].slice(0, 2), ["/usr/bin/ditto", "--noqtn"]);
    assert.deepEqual(await readdir(directory), [helperName]);
  });
});

test("reuses a copy that matches the bundled helper", async () => {
  await withHelper(async ({ helpersRoot, directory, binary, installed, copies, exec }) => {
    await installComputerHelper(binary, { helpersRoot, directory, exec });
    assert.equal(await installComputerHelper(binary, { helpersRoot, directory, exec }), installed);
    assert.equal(copies.length, 1);
  });
});

test("replaces a copy after an update or any other change", async () => {
  await withHelper(async ({ helpersRoot, directory, binary, installed, copies, exec }) => {
    await installComputerHelper(binary, { helpersRoot, directory, exec });
    await writeFile(binary, "helper v2");
    assert.equal(await installComputerHelper(binary, { helpersRoot, directory, exec }), installed);
    assert.equal(await readFile(installed, "utf8"), "helper v2");
    await writeFile(installed, "changed by something else");
    await installComputerHelper(binary, { helpersRoot, directory, exec });
    assert.equal(await readFile(installed, "utf8"), "helper v2");
    assert.equal(copies.length, 3);
  });
});

test("leaves a helper alone when it is not inside the app", async () => {
  await withHelper(async ({ helpersRoot, directory, copies, exec }) => {
    const development = "/repo/packages/computer-use/native/.build/release/ComputerUse";
    assert.equal(await installComputerHelper(development, { helpersRoot, directory, exec }), development);
    assert.equal(copies.length, 0);
  });
});

test("keeps the working copy when a new one does not match", async () => {
  await withHelper(async ({ helpersRoot, directory, binary, installed, exec }) => {
    await installComputerHelper(binary, { helpersRoot, directory, exec });
    await writeFile(binary, "helper v2");
    const corrupting = async (/** @type {string} */ file, /** @type {string[]} */ args) => {
      await exec(file, args);
      await writeFile(path.join(args[2], executable), "truncated");
    };
    await assert.rejects(installComputerHelper(binary, { helpersRoot, directory, exec: corrupting }), /did not copy correctly/);
    assert.equal(await readFile(installed, "utf8"), "helper v1");
    assert.deepEqual(await readdir(directory), [helperName]);
  });
});

/** A helper that reports both permissions on, recording what it was started from. */
function checkingHelper(/** @type {string[]} */ started) {
  return /** @type {any} */ ((/** @type {string} */ binary) => {
    started.push(binary);
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), kill() {} });
    setImmediate(() => {
      child.stdout.end(JSON.stringify({ ok: true, supported: true, accessibility: true, screenRecording: true, protocolVersion: "openwork.computer-use/1" }));
      child.emit("close", 0);
    });
    return child;
  });
}

const adapterOptions = { platform: "darwin", osRelease: "25.0.0", resourcesPath: "/App/Resources", fileExists: () => true };

test("this Mac checks and reports from the installed helper", async () => {
  /** @type {string[]} */
  const started = [];
  const adapter = createLocalComputerAdapter({ ...adapterOptions, spawnChild: checkingHelper(started), installHelper: async () => "/User/Data/ComputerUse" });
  assert.equal((await adapter.readiness()).readiness, "ready");
  assert.deepEqual(started, ["/User/Data/ComputerUse"]);
});

test("this Mac is unavailable when the helper cannot be installed", async () => {
  /** @type {string[]} */
  const started = [];
  const adapter = createLocalComputerAdapter({ ...adapterOptions, spawnChild: checkingHelper(started), installHelper: async () => { throw new Error("no space"); } });
  const state = await adapter.readiness();
  assert.equal(state.readiness, "unavailable");
  assert.match(state.detail, /could not set up/);
  assert.deepEqual(started, []);
});
