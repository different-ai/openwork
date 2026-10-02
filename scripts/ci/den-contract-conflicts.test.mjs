import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { afterEach, test } from "node:test";

import { isGeneratedContractPath, parseArgs } from "./den-contract-conflicts.mjs";

const script = resolve(import.meta.dirname, "den-contract-conflicts.mjs");
const tempDirs = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function git(repo, ...args) {
  const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd: repo,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function write(repo, path, content) {
  mkdirSync(dirname(resolve(repo, path)), { recursive: true });
  writeFileSync(resolve(repo, path), content);
}

// Builds `base` and `pr` branches that each rewrite the given paths from a
// shared starting commit.
function fixture(conflicting, { headOnly = {} } = {}) {
  const repo = mkdtempSync(resolve(tmpdir(), "den-contract-conflicts-test-"));
  tempDirs.push(repo);
  git(repo, "init", "-q", "-b", "base");
  for (const path of [...conflicting, "src/route.ts"]) write(repo, path, "start\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "start");
  git(repo, "checkout", "-q", "-b", "pr");
  for (const path of conflicting) write(repo, path, "head\n");
  for (const [path, content] of Object.entries(headOnly)) write(repo, path, content);
  git(repo, "add", ".");
  git(repo, "commit", "-q", "--allow-empty", "-m", "head");
  git(repo, "checkout", "-q", "base");
  for (const path of conflicting) write(repo, path, "base\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "--allow-empty", "-m", "base");
  return repo;
}

function classify(repo) {
  const result = spawnSync(process.execPath, [script, "--base", "base", "--head", "pr"], { cwd: repo, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("generated contract paths are the OpenAPI snapshot and the generated SDK", () => {
  assert.equal(isGeneratedContractPath("packages/docs/openapi.json"), true);
  assert.equal(isGeneratedContractPath("packages/sdk/src/gen/types.gen.ts"), true);
  assert.equal(isGeneratedContractPath("packages/docs/docs.json"), false);
  assert.equal(isGeneratedContractPath("packages/sdk/src/index.ts"), false);
  assert.equal(isGeneratedContractPath("packages/docs/openapi.json.bak"), false);
});

test("a merge without conflicts is clean", () => {
  assert.deepEqual(classify(fixture([], { headOnly: { "src/route.ts": "head\n" } })), { status: "clean", files: [] });
});

test("conflicts only in the generated contract can be regenerated", () => {
  const files = ["packages/docs/openapi.json", "packages/sdk/src/gen/types.gen.ts"];
  assert.deepEqual(classify(fixture(files, { headOnly: { "src/route.ts": "head\n" } })), { status: "generated", files });
});

test("any hand-written conflict needs a person", () => {
  const files = ["packages/docs/openapi.json", "src/route.ts"];
  assert.deepEqual(classify(fixture(files)), { status: "manual", files });
});

test("arguments require both refs", () => {
  assert.throws(() => parseArgs(["--base", "dev"]), /Usage/);
  assert.throws(() => parseArgs(["--head"]), /requires a value/);
  assert.throws(() => parseArgs(["--other", "x"]), /Unknown argument/);
});
