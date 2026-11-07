import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  exportDistribution, MARKETPLACE_FILES, PACKAGE_FILES, PACKAGE_PATH,
  REPOSITORY_ROOT, validateDistribution,
} from "./export-plugin.mjs";

const script = join(REPOSITORY_ROOT, "scripts/marketplaces/export-plugin.mjs");

function scratch(t) {
  const parent = join(tmpdir(), "opencode");
  mkdirSync(parent, { recursive: true });
  const root = realpathSync(mkdtempSync(join(parent, "plugin-distribution-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function fixture(t) {
  const temporary = scratch(t);
  const source = join(temporary, "source");
  const paths = [
    ...PACKAGE_FILES.map((path) => `${PACKAGE_PATH}/${path}`),
    ...MARKETPLACE_FILES,
    "LICENSE",
    "apps/app/public/openwork-logo-square.svg",
  ];
  for (const path of paths) {
    mkdirSync(dirname(join(source, path)), { recursive: true });
    cpSync(join(REPOSITORY_ROOT, path), join(source, path));
  }
  return { temporary, source, output: join(temporary, "export") };
}

function changeJson(path, change) {
  const value = JSON.parse(readFileSync(path, "utf8"));
  change(value);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function tree(root, prefix = "") {
  return readdirSync(join(root, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? tree(root, path) : [path];
  }).sort();
}

test("repository manifests, native overrides, endpoints, license and logo validate offline", () => {
  const result = validateDistribution();
  assert.equal(result.files.size, PACKAGE_FILES.length);
  assert.equal(result.catalogs.length, 3);
  assert.equal(result.version, "1.0.1");
  const portable = JSON.parse(result.files.get("mcp.json"));
  const native = JSON.parse(result.files.get(".mcp.json"));
  assert.equal(portable.mcpServers.openwork.type, "streamable-http");
  assert.equal(native.mcpServers.openwork.type, "http");
  assert.equal(native.mcpServers.openwork.url, portable.mcpServers.openwork.url);
});

test("export contains only byte-identical package files and relocated root catalogs", (t) => {
  const { source, output } = fixture(t);
  const result = exportDistribution(output, { sourceRoot: source });
  assert.deepEqual(tree(output), [...PACKAGE_FILES, ...MARKETPLACE_FILES].sort());
  assert.deepEqual(result.files, tree(output));
  for (const path of PACKAGE_FILES) {
    assert.deepEqual(readFileSync(join(output, path)), readFileSync(join(source, PACKAGE_PATH, path)), path);
  }
  for (const [index, path] of MARKETPLACE_FILES.entries()) {
    const expected = JSON.parse(readFileSync(join(source, path), "utf8"));
    if (index === 2) expected.plugins[0].source.path = "./";
    else expected.plugins[0].source = "./";
    assert.deepEqual(JSON.parse(readFileSync(join(output, path), "utf8")), expected);
  }
  assert.ok(result.bytes < 100_000, "Standalone output should stay far below monorepo archive limits");
  assert.equal(existsSync(join(output, ".git")), false);
  assert.equal(existsSync(join(output, "ee")), false);
  assert.equal(existsSync(join(output, "scripts")), false);
  validateDistribution(output, { standalone: true });
});

test("export preserves exact-identity guidance without claiming a native behavior pass", (t) => {
  const { source, output } = fixture(t);
  exportDistribution(output, { sourceRoot: source });
  const skill = readFileSync(join(output, "skills/openwork-connect/SKILL.md"), "utf8");
  assert.match(skill, /verify that\n   requested reference with a fresh `get_skill` call/);
  assert.match(skill, /not proof\n   that the user's requested name exists/);
  assert.match(skill, /`unknown_skill`/);
  assert.match(skill, /Do not execute, invent, automatically\n   create, or silently substitute another skill/);
  assert.match(skill, /unavailable to the current member/);
  const readme = readFileSync(join(output, "README.md"), "utf8");
  assert.match(readme, /1\.0\.1/);
  assert.match(readme, /2\.1\.281\+/);
  assert.match(readme, /not even a disabled one/);
  assert.match(readme, /Updated guidance needs native retest/);
});

test("two exports are deterministic and do not modify their source", (t) => {
  const { temporary, source, output } = fixture(t);
  const before = new Map(tree(source).map((path) => [path, readFileSync(join(source, path))]));
  const first = exportDistribution(output, { sourceRoot: source });
  const second = exportDistribution(join(temporary, "second"), { sourceRoot: source });
  assert.equal(first.bytes, second.bytes);
  for (const path of first.files) {
    assert.deepEqual(readFileSync(join(first.directory, path)), readFileSync(join(second.directory, path)), path);
  }
  assert.deepEqual(tree(source), [...before.keys()]);
  for (const [path, bytes] of before) assert.deepEqual(readFileSync(join(source, path)), bytes, path);
});

test("CLI resolves the source from its own file rather than the caller's cwd", (t) => {
  const temporary = scratch(t);
  const check = execFileSync(process.execPath, [script, "--check"], { cwd: temporary, encoding: "utf8" });
  assert.match(check, /9 package files and 3 repo catalogs \(offline only\)/);
  const output = join(temporary, "export");
  const result = JSON.parse(execFileSync(process.execPath, [script, "--output", output], { cwd: temporary, encoding: "utf8" }));
  assert.equal(result.directory, output);
  validateDistribution(output, { standalone: true });
});

test("CLI refuses implicit output, relative output and unknown options", (t) => {
  const temporary = scratch(t);
  for (const args of [[], ["--output", "relative-output"], ["--publish"], ["--check", "--output", join(temporary, "bad")]]) {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: temporary, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage:|explicit absolute path/);
  }
  assert.deepEqual(readdirSync(temporary), []);
});

test("refuses existing output without touching files", (t) => {
  const { source, output } = fixture(t);
  mkdirSync(output);
  writeFileSync(join(output, "keep.txt"), "existing user work\n");
  assert.throws(() => exportDistribution(output, { sourceRoot: source }), /already exists/);
  assert.equal(readFileSync(join(output, "keep.txt"), "utf8"), "existing user work\n");
});

test("refuses output inside the source checkout or any other Git checkout", (t) => {
  const { temporary, source } = fixture(t);
  const nested = join(source, "export");
  assert.throws(() => exportDistribution(nested, { sourceRoot: source }), /outside the source checkout/);
  assert.equal(existsSync(nested), false);
  for (const kind of ["directory", "worktree-file"]) {
    const other = join(temporary, kind);
    mkdirSync(other);
    // Sentinel entries model repositories without initializing any Git repository.
    if (kind === "directory") mkdirSync(join(other, ".git"));
    else writeFileSync(join(other, ".git"), "gitdir: /not-a-real-repository\n");
    const output = join(other, "export");
    assert.throws(() => exportDistribution(output, { sourceRoot: source }), /outside every Git checkout/);
    assert.equal(existsSync(output), false);
  }
});

test("refuses output aliases into a checkout and traversal paths", (t) => {
  const { temporary, source } = fixture(t);
  const alias = join(temporary, "alias");
  symlinkSync(source, alias, "dir");
  assert.throws(() => exportDistribution(join(alias, "export"), { sourceRoot: source }), /outside the source checkout/);
  assert.throws(() => exportDistribution(`${temporary}/../escape`, { sourceRoot: source }), /path traversal/);
  const dangling = join(temporary, "dangling");
  symlinkSync(join(temporary, "absent"), dangling);
  assert.throws(() => exportDistribution(dangling, { sourceRoot: source }), /already exists/);
});

test("refuses a missing parent instead of creating unrelated directories", (t) => {
  const { temporary, source } = fixture(t);
  const absent = join(temporary, "absent");
  assert.throws(() => exportDistribution(join(absent, "export"), { sourceRoot: source }), /ENOENT/);
  assert.equal(existsSync(absent), false);
});

for (const config of ["mcp.json", ".mcp.json"]) {
  test(`${config} rejects headers, credentials, commands, and changed endpoint`, (t) => {
    for (const change of [
      (value) => { value.mcpServers.openwork.headers = { Authorization: "Bearer not-a-real-credential" }; },
      (value) => { value.mcpServers.openwork.client_secret = "not-a-real-credential"; },
      (value) => { value.mcpServers.openwork.command = "unexpected-command"; },
      (value) => { value.mcpServers.openwork.url += "?token=not-a-real-credential"; },
    ]) {
      const { source, output } = fixture(t);
      changeJson(join(source, PACKAGE_PATH, config), change);
      assert.throws(() => exportDistribution(output, { sourceRoot: source }), /MCP configuration \(no credentials\)/);
      assert.equal(existsSync(output), false);
    }
  });
}

for (const manifest of [".claude-plugin/plugin.json", ".cursor-plugin/plugin.json"]) {
  test(`${manifest} rejects metadata drift, hooks, and escaping paths`, (t) => {
    for (const change of [
      (value) => { value.version = "2.0.0"; },
      (value) => { value.hooks = "./unexpected-hooks.json"; },
      (value) => { value.mcpServers = "./../outside.json"; },
      (value) => { value.icon = "/absolute/outside.svg"; },
    ]) {
      const { source, output } = fixture(t);
      changeJson(join(source, PACKAGE_PATH, manifest), change);
      assert.throws(() => exportDistribution(output, { sourceRoot: source }), /native manifest/);
      assert.equal(existsSync(output), false);
    }
  });
}

for (const catalog of MARKETPLACE_FILES) {
  test(`${catalog} rejects paths resolved outside the marketplace root`, (t) => {
    const { source, output } = fixture(t);
    changeJson(join(source, catalog), (value) => {
      if (typeof value.plugins[0].source === "string") value.plugins[0].source = "./../outside";
      else value.plugins[0].source.path = "./../outside";
    });
    assert.throws(() => exportDistribution(output, { sourceRoot: source }), /marketplace/);
    assert.equal(existsSync(output), false);
  });
}

test("rejects extra package files rather than leaking an environment file", (t) => {
  const { source, output } = fixture(t);
  writeFileSync(join(source, PACKAGE_PATH, ".env"), "UNEXPECTED_VALUE=not-a-real-credential\n");
  assert.throws(() => exportDistribution(output, { sourceRoot: source }), /file allowlist/);
  assert.equal(existsSync(output), false);
});

test("rejects symlinked files and package directories before creating output", (t) => {
  for (const location of ["file", "package"]) {
    const { temporary, source, output } = fixture(t);
    const path = location === "file" ? join(source, PACKAGE_PATH, "assets/logo.svg") : join(source, PACKAGE_PATH);
    const external = join(temporary, "external");
    cpSync(path, external, { recursive: true });
    rmSync(path, { recursive: true });
    symlinkSync(external, path, location === "file" ? "file" : "dir");
    assert.throws(() => exportDistribution(output, { sourceRoot: source }), /Symbolic links/);
    assert.equal(existsSync(output), false);
  }
});

test("rejects secret-like content, short README, and active SVG content", (t) => {
  for (const [path, contents, expected] of [
    ["README.md", `${readFileSync(join(REPOSITORY_ROOT, PACKAGE_PATH, "README.md"), "utf8")}\naccess example: Bearer ${"x".repeat(24)}\n`, /Possible credential/],
    ["README.md", "# Too short\n", /at least 40 words/],
    ["assets/logo.svg", '<svg viewBox="0 0 1024 1024"><script>unexpected()</script></svg>', /external content or scripts/],
  ]) {
    const { source, output } = fixture(t);
    writeFileSync(join(source, PACKAGE_PATH, path), contents);
    assert.throws(() => exportDistribution(output, { sourceRoot: source }), expected);
    assert.equal(existsSync(output), false);
  }
});
