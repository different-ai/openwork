import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  readHeadlessRuntimeManifest,
  resolveHeadlessWorldRuntimePaths,
  stopHeadlessRuntime,
} from "../src/headless-web.ts";
import { bootDevHeadless } from "../../../worlds/dev-headless.ts";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  options: { within: number; label: string },
): Promise<void> {
  const deadline = Date.now() + options.within;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${options.label}`);
}

test("the dev-headless world owns, reuses, rotates, and supervises its real services", { timeout: 180_000 }, async (context) => {
  const firstName = `headless-world-integration-${process.pid}`;
  const supervisedName = `headless-supervisor-integration-${process.pid}`;
  const names = [firstName, supervisedName];
  const cleanup = async () => {
    for (const name of names) {
      const paths = resolveHeadlessWorldRuntimePaths(REPO_ROOT, name);
      const manifest = await readHeadlessRuntimeManifest(paths.runtimeManifestPath);
      if (manifest) await stopHeadlessRuntime(manifest);
    }
  };
  context.after(cleanup);
  await cleanup();

  const stack = new AsyncDisposableStack();
  context.after(async () => stack.disposeAsync());
  const first = await bootDevHeadless(stack, { name: firstName, replace: true });
  const firstPaths = resolveHeadlessWorldRuntimePaths(REPO_ROOT, firstName);
  const firstManifest = first.manifest;
  assert.equal(first.reused, false);
  assert.equal(firstManifest.world?.name, firstName);
  assert.match(firstManifest.world?.launchId ?? "", /^[0-9a-f-]{36}$/i);
  assert.equal(firstManifest.runtimeManifestPath, firstPaths.runtimeManifestPath);
  assert.ok((firstManifest.supervisorPid ?? 0) > 0);
  assert.equal((await fetch(firstManifest.healthUrl)).ok, true);
  assert.equal((await fetch(firstManifest.webUrl)).ok, true);

  const reused = await bootDevHeadless(stack, { name: firstName });
  assert.equal(reused.reused, true);
  assert.equal(reused.manifest.world?.launchId, firstManifest.world?.launchId);
  assert.deepEqual(reused.manifest.pids, firstManifest.pids);
  assert.equal(reused.manifest.token, firstManifest.token);
  assert.equal(reused.manifest.hostToken, firstManifest.hostToken);

  const keptTokens = await bootDevHeadless(stack, {
    name: firstName,
    replace: true,
    keepTokens: true,
  });
  assert.equal(keptTokens.reused, false);
  assert.notEqual(keptTokens.manifest.world?.launchId, firstManifest.world?.launchId);
  assert.equal(keptTokens.manifest.token, firstManifest.token);
  assert.equal(keptTokens.manifest.hostToken, firstManifest.hostToken);

  const replaced = await bootDevHeadless(stack, {
    name: firstName,
    replace: true,
    keepTokens: true,
    rotateTokens: true,
  });
  assert.equal(replaced.reused, false);
  assert.notEqual(replaced.manifest.world?.launchId, keptTokens.manifest.world?.launchId);
  assert.notEqual(replaced.manifest.token, keptTokens.manifest.token);
  assert.notEqual(replaced.manifest.hostToken, keptTokens.manifest.hostToken);
  assert.deepEqual(await readHeadlessRuntimeManifest(firstPaths.runtimeManifestPath), replaced.manifest);

  await stack.disposeAsync();
  await waitUntil(
    async () => await readHeadlessRuntimeManifest(firstPaths.runtimeManifestPath) === null,
    { within: 10_000, label: "the owned runtime manifest to be removed" },
  );
  await assert.rejects(fetch(replaced.manifest.healthUrl));
  await assert.rejects(fetch(replaced.manifest.webUrl));

  const supervisedStack = new AsyncDisposableStack();
  context.after(async () => supervisedStack.disposeAsync());
  const supervised = await bootDevHeadless(supervisedStack, { name: supervisedName, replace: true });
  const supervisedPaths = resolveHeadlessWorldRuntimePaths(REPO_ROOT, supervisedName);
  const supervisedManifest = supervised.manifest;
  const webPid = supervisedManifest.pids.web;
  if (!webPid) throw new Error("The supervised headless world did not publish its web process");
  process.kill(webPid, "SIGTERM");

  await waitUntil(async () => {
    const manifestGone = await readHeadlessRuntimeManifest(supervisedPaths.runtimeManifestPath) === null;
    const serverStopped = await fetch(supervisedManifest.healthUrl).then(() => false, () => true);
    return manifestGone && serverStopped;
  }, { within: 15_000, label: "the supervisor to tear down the sibling backend" });
  await supervisedStack.disposeAsync();
});

test("dev:headless-web stays foreground and Ctrl-C owns teardown", { timeout: 180_000 }, async (context) => {
  const paths = resolveHeadlessWorldRuntimePaths(REPO_ROOT, "dev-headless");
  const existing = await readHeadlessRuntimeManifest(paths.runtimeManifestPath);
  if (existing) await stopHeadlessRuntime(existing);

  const output: string[] = [];
  const adjacentCorepack = join(
    dirname(process.execPath),
    process.platform === "win32" ? "corepack.cmd" : "corepack",
  );
  const npmExecPath = process.env.npm_execpath?.trim();
  const hasAdjacentCorepack = await access(adjacentCorepack).then(() => true, () => false);
  const launcherCommand = npmExecPath
    ? process.execPath
    : hasAdjacentCorepack
      ? adjacentCorepack
      : process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const launcherArgs = npmExecPath
    ? [npmExecPath, "dev:headless-web", "--replace"]
    : hasAdjacentCorepack
      ? ["pnpm", "dev:headless-web", "--replace"]
      : ["dev:headless-web", "--replace"];
  const launcher = spawn(launcherCommand, launcherArgs, {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  launcher.stdout.on("data", (chunk: Buffer) => output.push(String(chunk)));
  launcher.stderr.on("data", (chunk: Buffer) => output.push(String(chunk)));
  let launcherError: Error | null = null;
  launcher.once("error", (error) => { launcherError = error; });
  context.after(async () => {
    const manifest = await readHeadlessRuntimeManifest(paths.runtimeManifestPath);
    if (manifest) await stopHeadlessRuntime(manifest);
    if (launcher.exitCode === null) launcher.kill("SIGTERM");
  });

  let manifest = await readHeadlessRuntimeManifest(paths.runtimeManifestPath);
  await waitUntil(async () => {
    if (launcherError !== null) throw launcherError;
    manifest = await readHeadlessRuntimeManifest(paths.runtimeManifestPath);
    if (launcher.exitCode !== null) {
      throw new Error(`dev:headless-web exited before health with ${launcher.exitCode}:\n${output.join("")}`);
    }
    return manifest !== null
      && await fetch(manifest.healthUrl).then((response) => response.ok, () => false);
  }, { within: 60_000, label: `the foreground compatibility launch\n${output.join("")}` });
  if (!manifest) throw new Error("dev:headless-web did not publish a healthy runtime manifest");
  const activeManifest = manifest;
  assert.equal(launcher.exitCode, null);
  await waitUntil(
    () => output.join("").includes("Ctrl-C (or pnpm world down dev-headless) tears it down."),
    { within: 15_000, label: `the foreground readiness message\n${output.join("")}` },
  );

  process.kill(activeManifest.pids.launcher, "SIGINT");
  await waitUntil(
    async () => await readHeadlessRuntimeManifest(paths.runtimeManifestPath) === null,
    { within: 15_000, label: `the foreground manifest cleanup\n${output.join("")}` },
  );
  await waitUntil(
    () => fetch(activeManifest.healthUrl).then(() => false, () => true),
    { within: 15_000, label: `the foreground server teardown\n${output.join("")}` },
  );
  await waitUntil(
    () => launcher.exitCode !== null,
    { within: 15_000, label: `the foreground launcher exit\n${output.join("")}` },
  );
  assert.equal(launcher.exitCode, 0);
});
