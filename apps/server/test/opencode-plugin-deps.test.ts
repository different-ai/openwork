import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { seedManagedOpencodePluginDeps, seedOpencodePluginDeps } from "../src/selfhost-web.js";

const manifest = '{"dependencies":{"fixture-plugin":"1.0.0"}}\n';
const lockfile = '{"lockfileVersion":3}\n';
const moduleSource = 'export const fixture = true;\n';

test("single seed awaits extraction, reports duration and skips a completed install", async () => {
  const f = await fixture();
  let now = 100;
  try {
    const result = await seedOpencodePluginDeps({ archive: f.archive, configDir: f.global, now: () => now++ });
    assert.deepEqual(result, { seeded: true, durationMs: 1 });
    await assertSeeded(f.global);
    // Even a broken archive must not be extracted over existing install state.
    await writeFile(f.archive, "broken");
    assert.deepEqual(await seedOpencodePluginDeps({ archive: f.archive, configDir: f.global }), {
      seeded: false, reason: "already-set-up",
    });
    await assertSeeded(f.global);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("single seed never throws on extraction failure and leaves normal installation possible", async () => {
  const f = await fixture();
  try {
    await writeFile(f.archive, "broken");
    const result = await seedOpencodePluginDeps({ archive: f.archive, configDir: f.global });
    assert.equal(result.seeded, false);
    if (result.seeded) assert.fail("broken archive cannot seed dependencies");
    assert.equal(result.reason, "failed");
    assert.match(result.error ?? "", /exited with/);
    assert.deepEqual(await readdir(f.global), []);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "openwork-plugin-deps-test-"));
  const source = join(root, "source");
  await mkdir(join(source, "node_modules", "fixture-plugin"), { recursive: true });
  await writeFile(join(source, "package.json"), manifest);
  await writeFile(join(source, "package-lock.json"), lockfile);
  await writeFile(join(source, "node_modules", "fixture-plugin", "index.js"), moduleSource);
  const archive = join(root, "deps.tgz");
  const packed = spawnSync("tar", ["-czf", archive, "-C", source, "package.json", "package-lock.json", "node_modules"], { encoding: "utf8" });
  assert.equal(packed.status, 0, packed.error?.message ?? packed.stderr);
  const cwd = join(root, "workspace");
  const home = join(root, "home");
  const xdg = join(root, "config");
  const env: NodeJS.ProcessEnv = { HOME: home, XDG_CONFIG_HOME: xdg };
  return { root, archive, cwd, home, env, global: join(xdg, "opencode") };
}

async function assertSeeded(directory: string) {
  assert.equal(await readFile(join(directory, "package.json"), "utf8"), manifest);
  assert.equal(await readFile(join(directory, "package-lock.json"), "utf8"), lockfile);
  assert.equal(await readFile(join(directory, "node_modules", "fixture-plugin", "index.js"), "utf8"), moduleSource);
  assert.equal((await readdir(directory)).some((entry) => entry.startsWith(".openwork-plugin-deps-")), false);
}

test("seeds global, explicit, project and discovery-home installs without changing user configs", async () => {
  const f = await fixture();
  try {
    const discoveryHome = join(f.root, "discovery-home");
    const explicit = join(f.root, "explicit-config");
    const project = join(f.cwd, ".opencode");
    const discovery = join(discoveryHome, ".opencode");
    const customConfig = join(f.root, "custom-opencode.json");
    const config = '{"plugin":["file:///custom-plugin.js"]}\n';
    await writeFile(customConfig, config);
    for (const directory of [project, discovery]) {
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "opencode.jsonc"), "// user configuration\n{}\n");
    }
    const results = await seedManagedOpencodePluginDeps({
      ...f,
      env: { ...f.env, OPENCODE_TEST_HOME: discoveryHome, OPENCODE_CONFIG_DIR: explicit, OPENCODE_CONFIG: customConfig },
    });
    assert.deepEqual(results.map((entry) => entry.configDir), [f.global, explicit, project, discovery]);
    assert.ok(results.every((entry) => entry.result.seeded));
    for (const directory of [f.global, explicit, project, discovery]) await assertSeeded(directory);
    assert.equal(await readFile(customConfig, "utf8"), config);
    for (const directory of [project, discovery]) {
      assert.equal(await readFile(join(directory, "opencode.jsonc"), "utf8"), "// user configuration\n{}\n");
    }
    assert.equal(existsSync(join(f.home, ".opencode")), false);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("seeds registered workspace folders when the engine starts in a separate scratch directory", async () => {
  const f = await fixture();
  try {
    const scratch = join(f.root, "scratch");
    const secondWorkspace = join(f.root, "second-workspace");
    const withoutConfig = join(f.root, "no-project-config");
    for (const directory of [f.cwd, secondWorkspace]) await mkdir(join(directory, ".opencode"), { recursive: true });
    const results = await seedManagedOpencodePluginDeps({
      ...f, cwd: scratch, workspaceDirs: [f.cwd, secondWorkspace, withoutConfig, f.cwd],
    });
    assert.deepEqual(results.map((entry) => entry.configDir), [f.global, join(f.cwd, ".opencode"), join(secondWorkspace, ".opencode")]);
    for (const entry of results) await assertSeeded(entry.configDir);
    assert.equal(existsSync(scratch), false);
    assert.equal(existsSync(withoutConfig), false);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("uses HOME for default global config and discovery without creating absent project state", async () => {
  const f = await fixture();
  try {
    const discovery = join(f.home, ".opencode");
    await mkdir(discovery, { recursive: true });
    const results = await seedManagedOpencodePluginDeps({ ...f, env: { HOME: f.home } });
    const global = join(f.home, ".config", "opencode");
    assert.deepEqual(results.map((entry) => entry.configDir), [global, discovery]);
    await assertSeeded(global);
    await assertSeeded(discovery);
    assert.equal(existsSync(f.cwd), false);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("preserves each kind of existing install state and lets OpenCode manage it", async () => {
  const f = await fixture();
  try {
    const project = join(f.cwd, ".opencode");
    const discovery = join(f.home, ".opencode");
    await mkdir(f.global, { recursive: true });
    await mkdir(project, { recursive: true });
    await mkdir(join(discovery, "node_modules"), { recursive: true });
    await writeFile(join(f.global, "package.json"), "user manifest");
    await writeFile(join(project, "package-lock.json"), "user lock");
    await writeFile(join(discovery, "node_modules", "keep.txt"), "user module");
    const results = await seedManagedOpencodePluginDeps(f);
    assert.equal(results.length, 3);
    for (const entry of results) assert.deepEqual(entry.result, { seeded: false, reason: "already-set-up" });
    assert.deepEqual(await readdir(f.global), ["package.json"]);
    assert.deepEqual(await readdir(project), ["package-lock.json"]);
    assert.deepEqual(await readdir(discovery), ["node_modules"]);
    assert.equal(await readFile(join(f.global, "package.json"), "utf8"), "user manifest");
    assert.equal(await readFile(join(project, "package-lock.json"), "utf8"), "user lock");
    assert.equal(await readFile(join(discovery, "node_modules", "keep.txt"), "utf8"), "user module");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("missing archives do not create even explicitly configured directories", async () => {
  const f = await fixture();
  try {
    const before = await readdir(f.root);
    assert.deepEqual(await seedManagedOpencodePluginDeps({
      ...f,
      archive: join(f.root, "missing.tgz"),
      env: { ...f.env, OPENCODE_CONFIG_DIR: join(f.root, "explicit") },
    }), []);
    assert.deepEqual(await readdir(f.root), before);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("deduplicates normalized config, workspace and discovery paths", async () => {
  const f = await fixture();
  try {
    const shared = join(f.cwd, ".opencode");
    await mkdir(shared, { recursive: true });
    const results = await seedManagedOpencodePluginDeps({
      ...f,
      env: { ...f.env, HOME: f.cwd, OPENCODE_CONFIG_DIR: "./.opencode/../.opencode" },
    });
    assert.deepEqual(results.map((entry) => entry.configDir), [f.global, shared]);
    assert.ok(results.every((entry) => entry.result.seeded));
    await assertSeeded(shared);
    const again = await seedManagedOpencodePluginDeps({ ...f, env: { ...f.env, OPENCODE_CONFIG_DIR: f.global } });
    assert.equal(again.filter((entry) => entry.configDir === f.global).length, 1);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("failed archive extraction falls back without install state or staging leftovers", async () => {
  const f = await fixture();
  try {
    await writeFile(f.archive, "not a tar archive");
    const project = join(f.cwd, ".opencode");
    await mkdir(project, { recursive: true });
    await writeFile(join(project, "opencode.json"), "{}\n");
    const results = await seedManagedOpencodePluginDeps(f);
    assert.equal(results.length, 2);
    for (const entry of results) {
      assert.equal(entry.result.seeded, false);
      if (!entry.result.seeded) {
        assert.equal(entry.result.reason, "failed");
        assert.ok(entry.result.error);
      }
    }
    assert.deepEqual(await readdir(f.global), []);
    assert.deepEqual(await readdir(project), ["opencode.json"]);
    assert.equal(await readFile(join(project, "opencode.json"), "utf8"), "{}\n");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
