import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const script = resolve("scripts/architecture/snapshot-composition.mjs");

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function write(root, path, contents) {
  const absolute = join(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, contents, "utf8");
}

test("snapshot counts repository inputs but excludes ignored package output", async () => {
  const root = await mkdtemp(join(tmpdir(), "openwork-architecture-snapshot-"));
  try {
    git(root, "init", "--quiet");
    git(root, "config", "user.email", "snapshot@example.invalid");
    git(root, "config", "user.name", "Snapshot Test");

    await write(
      root,
      ".gitignore",
      "apps/desktop/dist-electron/\nevals/flows/generated/\n",
    );
    await write(
      root,
      "apps/app/package.json",
      `${JSON.stringify({ name: "fixture-app", private: true }, null, 2)}\n`,
    );
    await write(root, "apps/app/src/tracked.ts", "export const tracked = true;\n");
    await write(root, "apps/app/src/deleted.ts", "export const deleted = true;\n");
    await write(root, "apps/app/tests/tracked.test.ts", "export const test = true;\n");
    await write(root, "evals/flows/tracked.flow.mjs", "export default {};\n");
    git(root, "add", ".");
    git(root, "commit", "--quiet", "-m", "fixture");

    await unlink(join(root, "apps/app/src/deleted.ts"));
    await write(root, "apps/app/src/in-progress.ts", "export const inProgress = true;\n");
    await write(
      root,
      "apps/desktop/dist-electron/copied-source.js",
      'import "@opencode-ai/sdk";\n'.repeat(600),
    );
    await write(root, "evals/flows/generated/ignored.flow.mjs", "export default {};\n");

    const result = JSON.parse(
      execFileSync(process.execPath, [script, root], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );

    assert.equal(result.totals.workspaces, 1);
    assert.equal(result.totals.implementationFiles, 2);
    assert.equal(result.totals.implementationLines, 2);
    assert.equal(result.totals.testFiles, 1);
    assert.equal(result.totals.fraimzFlows, 1);
    assert.equal(result.largeImplementationFiles.over500, 0);
    assert.equal(result.dependencyCoupling.opencodeSdk.sites, 0);
    assert.equal(result.dirty, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
