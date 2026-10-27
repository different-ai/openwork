import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { assertPortablePluginDeps, buildOpencodePluginDeps } from "./build-opencode-plugin-deps.mjs";

test("packs plugin dependencies without a drive-letter archive operand or shell quoting", async () => {
  const root = await mkdtemp(join(tmpdir(), "openwork plugin archive "));
  // A colon reproduces GNU tar's remote-host syntax even on non-Windows CI.
  const packageRoot = join(root, process.platform === "win32" ? "drive-path" : "C:", "repo with spaces", "apps", "server");
  const calls = [];
  let staging;
  try {
    await mkdir(packageRoot, { recursive: true });
    await writeFile(join(packageRoot, "..", "..", "constants.json"), JSON.stringify({ opencodeVersion: "v1.18.30" }));
    const archive = await buildOpencodePluginDeps(packageRoot, {
      runCommand(command, args, cwd) {
        calls.push({ command, args, cwd });
        if (command === "npm" || command === "npm.cmd") {
          staging = cwd;
          assert.ok(args.includes("--ignore-scripts"));
          assert.ok(args.includes("--omit=optional"));
          // No network needed: exercise the real archive creation with an install fixture.
          const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
            import { mkdirSync, writeFileSync } from 'node:fs';
            mkdirSync('node_modules/fixture-plugin', { recursive: true });
            writeFileSync('node_modules/fixture-plugin/index.js', 'export const fixture = true;');
            writeFileSync('package-lock.json', '{}');
          `], { cwd, encoding: "utf8" });
          assert.equal(result.status, 0, result.stderr);
          return;
        }
        assert.equal(command, "tar");
        assert.equal(args[1], "opencode-plugin-deps-1.18.30.tgz");
        assert.equal(args[1].includes(":"), false);
        const result = spawnSync(command, args, { cwd, encoding: "utf8" });
        assert.equal(result.status, 0, result.error?.message ?? result.stderr);
      },
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].cwd, dirname(archive));
    const extracted = join(root, "extracted with spaces");
    await mkdir(extracted);
    const result = spawnSync("tar", ["-xzf", basename(archive), "-C", extracted], { cwd: dirname(archive), encoding: "utf8" });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    assert.deepEqual(JSON.parse(await readFile(join(extracted, "package.json"), "utf8")), {
      dependencies: { "@opencode-ai/plugin": "1.18.30" },
    });
    assert.equal(await readFile(join(extracted, "node_modules", "fixture-plugin", "index.js"), "utf8"), "export const fixture = true;");
    await assert.rejects(readFile(join(staging, "package.json")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const [name, bytes] of [
  ["addon.node", Buffer.from("not a native header")],
  ["mach-o", Buffer.from("cffaedfe", "hex")],
  ["universal", Buffer.from("cafebabe", "hex")],
  ["elf", Buffer.from("7f454c46", "hex")],
  ["pe", Buffer.from("4d5a9000", "hex")],
]) {
  test(`rejects unsigned native code in the archive: ${name}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "openwork-plugin-native-"));
    try {
      const nested = join(root, "nested-package", "prebuilds");
      await mkdir(nested, { recursive: true });
      await writeFile(join(nested, name), bytes);
      await assert.rejects(assertPortablePluginDeps(root), /Native code cannot be bundled/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
