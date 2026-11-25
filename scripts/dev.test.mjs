import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const variables = ["OPENWORK_DEV_MODE", "OPENWORK_DEV_PROFILE", "OPENWORK_ELECTRON_USE_MOCK_KEYCHAIN", "OPENWORK_ELECTRON_REMOTE_DEBUG_PORT", "PORT"];
const entry = `
console.log(JSON.stringify({
  cwd: process.cwd(),
  args: process.argv.slice(2),
  env: Object.fromEntries(${JSON.stringify(variables)}.map((key) => [key, process.env[key] ?? null])),
}));
process.exitCode = Number(process.env.DEV_TEST_EXIT_CODE ?? 0);
`;

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "openwork dev "));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const [file, content] of [
    ["apps/app/package.json", '{"type":"module"}'],
    ["apps/app/node_modules/vite/package.json", '{"name":"vite","type":"module","exports":{"./package.json":"./package.json"}}'],
    ["apps/app/node_modules/vite/bin/vite.js", entry],
    ["apps/desktop/scripts/electron-dev.mjs", entry],
  ]) {
    mkdirSync(dirname(join(directory, file)), { recursive: true });
    writeFileSync(join(directory, file), content);
  }
  mkdirSync(join(directory, "scripts"));
  if (existsSync(join(root, "scripts/dev.mjs"))) {
    copyFileSync(join(root, "scripts/dev.mjs"), join(directory, "scripts/dev.mjs"));
  }
  const env = { ...process.env };
  for (const key of variables) delete env[key];
  delete env.DEV_TEST_EXIT_CODE;
  return {
    directory,
    script(manifest, name, overrides = {}) {
      const { scripts } = JSON.parse(readFileSync(join(root, manifest), "utf8"));
      return spawnSync(scripts[name], {
        cwd: dirname(join(directory, manifest)), env: { ...env, ...overrides },
        encoding: "utf8", shell: true, timeout: 10_000,
      });
    },
    cli(mode, args, overrides = {}) {
      return spawnSync(process.execPath, [join(directory, "scripts/dev.mjs"), mode, ...args], {
        cwd: directory, env: { ...env, ...overrides }, encoding: "utf8", timeout: 10_000,
      });
    },
  };
}

function output(result) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

for (const [manifest, name, target] of [
  ["package.json", "dev", "desktop"],
  ["package.json", "dev:worktree", "desktop"],
  ["package.json", "dev:electron", "desktop"],
  ["package.json", "dev:ui", "app"],
  ["apps/app/package.json", "dev", "app"],
  ["apps/app/package.json", "dev:web", "app"],
]) {
  test(`${manifest} ${name} runs in the package directory with dev mode enabled`, (t) => {
    const app = fixture(t);
    const result = output(app.script(manifest, name, { OPENWORK_DEV_MODE: "0" }));
    assert.equal(result.cwd, join(app.directory, "apps", target));
    assert.equal(result.env.OPENWORK_DEV_MODE, "1");
  });
}

test("desktop debug port defaults for unset and empty values, not explicit values", (t) => {
  const app = fixture(t);
  for (const value of [undefined, "", "0", "9123", " "]) {
    const env = value === undefined ? {} : { OPENWORK_ELECTRON_REMOTE_DEBUG_PORT: value };
    const result = output(app.script("package.json", "dev", env));
    assert.equal(result.env.OPENWORK_ELECTRON_REMOTE_DEBUG_PORT, value || "9823");
  }
});

test("worktree fixes its profile and ports while preserving a nonempty keychain override", (t) => {
  const app = fixture(t);
  for (const value of [undefined, "", "0", "false", " "]) {
    const env = { OPENWORK_DEV_PROFILE: "custom", OPENWORK_ELECTRON_REMOTE_DEBUG_PORT: "9123", PORT: "5173" };
    if (value !== undefined) env.OPENWORK_ELECTRON_USE_MOCK_KEYCHAIN = value;
    const result = output(app.script("package.json", "dev:worktree", env));
    assert.deepEqual(result.env, {
      OPENWORK_DEV_MODE: "1",
      OPENWORK_DEV_PROFILE: "auto",
      OPENWORK_ELECTRON_USE_MOCK_KEYCHAIN: value || "1",
      OPENWORK_ELECTRON_REMOTE_DEBUG_PORT: "0",
      PORT: "0",
    });
  }
});

test("electron and UI aliases do not enable remote debugging or override the port", (t) => {
  const app = fixture(t);
  for (const name of ["dev:electron", "dev:ui"]) {
    const result = output(app.script("package.json", name, { PORT: "5178" }));
    assert.equal(result.env.OPENWORK_ELECTRON_REMOTE_DEBUG_PORT, null);
    assert.equal(result.env.PORT, "5178");
    assert.equal(result.env.OPENWORK_DEV_PROFILE, null);
    assert.equal(result.env.OPENWORK_ELECTRON_USE_MOCK_KEYCHAIN, null);
  }
});

test("arguments reach the existing entry points without shell expansion", (t) => {
  const app = fixture(t);
  const args = ["--blank-slate", "two words", "$HOME", "a&b", 'a"b', "--"];
  for (const mode of ["desktop", "worktree", "electron", "ui"]) {
    assert.deepEqual(output(app.cli(mode, args)).args, args);
  }
});

test("entry point failures keep their exit status", (t) => {
  const app = fixture(t);
  for (const name of ["dev", "dev:ui"]) {
    const result = app.script("package.json", name, { DEV_TEST_EXIT_CODE: "7" });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 7, result.stderr);
  }
});

test("unknown targets fail before launching an entry point", (t) => {
  const result = fixture(t).cli("unknown", []);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Usage: node scripts\/dev\.mjs/);
  assert.equal(result.stdout, "");
});
