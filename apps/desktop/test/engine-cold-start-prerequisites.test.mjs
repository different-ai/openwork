import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

for (const missing of ["server", "archive", "engine"]) {
  test(`cold-engine test fails before startup when ${missing} preparation is missing`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "openwork-cold-prerequisites-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const tests = join(root, "apps/desktop/test");
    const dist = join(root, "apps/server/dist");
    await mkdir(tests, { recursive: true });
    await mkdir(dist, { recursive: true });
    const entry = join(tests, "engine-cold-start.test.mjs");
    await copyFile(new URL("./engine-cold-start.test.mjs", import.meta.url), entry);
    await writeFile(join(root, "constants.json"), JSON.stringify({ opencodeVersion: "1.18.30" }));
    if (missing !== "server") await writeFile(join(dist, "embedded.js"), "throw new Error('must not import before preflight');");
    if (missing === "engine") await writeFile(join(dist, "opencode-plugin-deps-1.18.30.tgz"), "not extracted during preflight");
    const result = spawnSync(process.execPath, ["--test", entry], {
      cwd: root, timeout: 5_000, encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: root, USERPROFILE: root, SYSTEMROOT: process.env.SYSTEMROOT },
    });
    assert.equal(result.error, undefined, "missing assets must not hang on the deliberately unavailable registry");
    assert.equal(result.status, 1);
    const output = result.stdout + result.stderr;
    assert.ok(output.includes(missing === "engine" ? "Missing pinned engine" : "Missing packaged server prerequisites"), output);
    assert.ok(output.includes("apps/desktop/test/README.md"), "the failure must point to preparation instructions");
    assert.ok(!output.includes("must not import before preflight"), "the server must not start with incomplete assets");
  });
}
