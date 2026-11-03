import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const binary = process.env.OPENWORK_TEST_OPENCODE2 ?? "/Applications/OpenWork.app/Contents/Resources/sidecars/opencode2";

test("real managed V2 ownership, restart, and v1 routing", { timeout: 180_000 }, async t => {
  try { await access(binary); } catch {
    t.skip(`needs: pinned OpenCode 2.0.26 binary (${binary}); set OPENWORK_TEST_OPENCODE2`);
    return;
  }
  const version = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 15_000 });
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, /\bv2\.0\.26\b/);
  const temp = process.env.OPENCODE_TEST_TMPDIR ?? join(tmpdir(), "opencode");
  await mkdir(temp, { recursive: true });
  const root = await mkdtemp(join(temp, "openwork-managed-native-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const plugins = join(root, "plugins");
  await mkdir(plugins);
  const entries = ["openwork-gateway-quota-v2", "openwork-provider-filters-v2", "openwork-mcp-results-v2", "openwork-mcp-readiness-v2", "openwork-visible-reasoning-v2", "openwork-agent-permissions-v2", "openwork-context-v2"];
  const buildPlugins = spawnSync("bun", ["build", ...entries.map(name => join(repo, "apps/server/src/opencode-plugins", `${name}.ts`)), "--target=node", "--format=esm", `--outdir=${plugins}`], { cwd: repo, encoding: "utf8", timeout: 30_000 });
  assert.equal(buildPlugins.status, 0, buildPlugins.stderr);
  const buildProvider = spawnSync("bun", ["build", join(repo, "packages/opencode-plugin/server.ts"), "--target=node", "--format=esm", `--outfile=${join(plugins, "openwork-provider-sync-v2.js")}`], { cwd: repo, encoding: "utf8", timeout: 30_000 });
  assert.equal(buildProvider.status, 0, buildProvider.stderr);
  const attacker = join(plugins, "untrusted-project");
  await mkdir(attacker);
  const buildAttacker = spawnSync("bun", ["build", join(repo, "apps/server/test/fixtures/live-provider-malicious-project-plugin.ts"), "--target=node", "--format=esm", `--outfile=${join(attacker, "server.mjs")}`], { cwd: repo, encoding: "utf8", timeout: 30_000 });
  assert.equal(buildAttacker.status, 0, buildAttacker.stderr);
  const worker = join(root, "worker.mjs");
  const build = spawnSync("bun", ["build", join(repo, "apps/server/test/fixtures/live-provider-managed-worker.ts"), "--target=node", "--format=esm", "--packages=external", `--outfile=${worker}`], { cwd: repo, encoding: "utf8", timeout: 30_000 });
  assert.equal(build.status, 0, build.stderr);
  await symlink(join(repo, "apps/server/node_modules"), join(root, "node_modules"), "dir");
  const home = join(root, "home");
  await mkdir(home);
  const child = spawn(process.execPath, [worker, root], {
    cwd: repo,
    env: {
      PATH: process.env.PATH, HOME: home, OPENCODE_TEST_HOME: home,
      XDG_CONFIG_HOME: join(home, "config"), XDG_CACHE_HOME: join(home, "cache"),
      XDG_DATA_HOME: join(home, "data"), XDG_STATE_HOME: join(home, "state"),
      OPENWORK_RUNTIME_DB: join(root, "runtime.sqlite"),
      OPENWORK_OPENCODE2_BIN: binary, OPENWORK_EXTENSIONS_PLUGIN_DIR: plugins,
      OPENCODE_DISABLE_MODELS_FETCH: "true", OPENCODE_DB: join(home, "missing-v1.db"),
      // Required when the test itself runs under Electron's Node, never a desktop window.
      ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", chunk => { output += String(chunk); });
  child.stderr.on("data", chunk => { output += String(chunk); });
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 150_000);
  try {
    const [code] = await once(child, "exit");
    assert.equal(code, 0, output);
    for (const line of output.split("\n").filter(line => line.startsWith("Passed managed"))) t.diagnostic(line);
    assert.equal(output.split("\n").filter(line => line.startsWith("Passed managed")).length, 7, output);
  } finally {
    clearTimeout(watchdog);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});
