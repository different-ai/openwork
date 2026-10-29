import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { reviewBuildGate } from "../../evals/worlds/review-build.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const helper = new URL("../../evals/worlds/review-build.ts", import.meta.url).href;

test("non-review worlds and ordinary local runs do not build", () => {
  let builds = 0;
  const prepare = reviewBuildGate(() => { builds++; });
  assert.equal(builds, 0);
  prepare(false);
  prepare(false);
  assert.equal(builds, 0);
  prepare(true);
  prepare(true);
  assert.equal(builds, 1);
});

test("a failed build never becomes a successful preparation", () => {
  let builds = 0;
  const prepare = reviewBuildGate(() => { builds++; throw new Error("build failed"); });
  assert.throws(() => prepare(true), /build failed/);
  assert.throws(() => prepare(true), /build failed/);
  assert.equal(builds, 2);
});

test("production build runs from the checkout once, not from restored output", () => {
  const directory = mkdtempSync(join(tmpdir(), "proof-review-build-"));
  const receipt = join(directory, "receipt.jsonl");
  try {
    writeFileSync(join(directory, "pnpm"), `#!/usr/bin/env node
require('node:fs').appendFileSync(process.env.RECEIPT, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }) + '\\n');
process.exit(Number(process.env.BUILD_EXIT || 0));
`, { mode: 0o755 });
    const run = (enabled, body, exit = "0") => spawnSync(process.execPath, ["--input-type=module", "-e", `import { prepareReviewBuild } from ${JSON.stringify(helper)}; ${body}`], {
      cwd: directory,
      encoding: "utf8",
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, RECEIPT: receipt, BUILD_EXIT: exit, OPENWORK_EVAL_BUILD_REVIEW_APP: enabled },
    });
    assert.equal(run("1", "/* only importing a non-review world */").status, 0);
    assert.equal(run("0", "prepareReviewBuild();").status, 0);
    assert.equal(run("1", "prepareReviewBuild(); prepareReviewBuild();").status, 0);
    const rows = readFileSync(receipt, "utf8").trim().split("\n").map(row => JSON.parse(row));
    assert.deepEqual(rows, [{ cwd: root.replace(/\/$/, ""), args: ["--filter", "@openwork/review-app", "build"] }]);
    const failure = run("1", "prepareReviewBuild(); console.log('must not start');", "7");
    assert.notEqual(failure.status, 0);
    assert.match(failure.stderr, /Production review build failed \(7\)/);
    assert.doesNotMatch(failure.stdout, /must not start/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("only the secret-free proof lane opts in; review servers prepare before starting", () => {
  const workflow = readFileSync(join(root, ".github/workflows/pr-proof.yml"), "utf8");
  const normal = workflow.split("\n  proof:\n")[1].split("\n  # Packaged specs")[0];
  assert.match(normal, /OPENWORK_EVAL_BUILD_REVIEW_APP: "1"/);
  assert.doesNotMatch(normal, /@openwork\/review-app build|secrets\./);
  assert.equal(workflow.match(/OPENWORK_EVAL_BUILD_REVIEW_APP:/g)?.length, 1);
});

test("proofs install and verify the locked Electron executable before native startup", () => {
  const workflow = readFileSync(join(root, ".github/workflows/pr-proof.yml"), "utf8");
  const normal = workflow.split("\n  proof:\n")[1].split("\n  # Packaged specs")[0];
  const install = normal.indexOf("pnpm --filter @openwork/desktop exec install-electron");
  const verify = normal.indexOf("fs.accessSync(binary, fs.constants.X_OK)");
  const run = normal.indexOf("- name: Run the selected changed spec on the PR head");
  assert.ok(install > normal.indexOf("./.github/actions/setup-tests"));
  assert.ok(verify > install);
  assert.ok(run > verify);
});
