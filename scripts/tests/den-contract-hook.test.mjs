import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runContractHook } from "../den-contract-hook.mjs";
import { fileURLToPath } from "node:url";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "openwork-contract-hook-"));
  roots.push(cwd);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: join(cwd, "empty-global-config"), GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...args) => execFileSync("git", args, { cwd, env, encoding: "utf8" });
  const write = (path, value) => { const file = join(cwd, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, value); };
  git("init", "-q");
  git("config", "user.name", "Contract test"); git("config", "user.email", "contract@example.test");
  for (const path of ["ee/apps/den-api/src/route.ts", "ee/packages/den-db/src/schema.ts", "packages/docs/openapi.json", "packages/sdk/src/gen/sdk.gen.ts", "notes.md"])
    write(path, "original\n");
  write(".githooks/pre-commit", "#!/bin/sh\nexit 0\n");
  git("add", "."); git("commit", "-qm", "fixture");
  return { cwd, env, git, write };
}

test("unrelated commits take the fast path without generating anything", () => {
  const f = fixture(); f.write("notes.md", "updated\n"); f.git("add", "notes.md");
  assert.equal(runContractHook({ cwd: f.cwd, generate: () => assert.fail("must not generate") }), false);
});

test("regeneration stages only outputs and preserves unrelated unstaged work", () => {
  const f = fixture(); f.write("ee/apps/den-api/src/route.ts", "new route\n"); f.git("add", "ee/apps/den-api/src/route.ts");
  f.write("notes.md", "private unfinished note\n");
  let runs = 0;
  assert.equal(runContractHook({ cwd: f.cwd, generate: () => {
    runs++; f.write("packages/docs/openapi.json", "new contract\n"); f.write("packages/sdk/src/gen/sdk.gen.ts", "new SDK\n");
  } }), true);
  assert.equal(runs, 1);
  assert.equal(f.git("show", ":packages/docs/openapi.json"), "new contract\n");
  assert.equal(f.git("show", ":packages/sdk/src/gen/sdk.gen.ts"), "new SDK\n");
  assert.equal(f.git("show", ":notes.md"), "original\n");
  assert.equal(readFileSync(join(f.cwd, "notes.md"), "utf8"), "private unfinished note\n");
});

for (const [name, path] of [
  ["partially staged source", "ee/apps/den-api/src/route.ts"],
  ["unstaged dependency", "ee/packages/den-db/src/schema.ts"],
  ["unstaged generated output", "packages/docs/openapi.json"],
  ["untracked API input with spaces", "ee/apps/den-api/src/new route.ts"],
]) test(`${name} stops before generation or index changes`, () => {
  const f = fixture(); f.write("ee/apps/den-api/src/route.ts", "staged route\n"); f.git("add", "ee/apps/den-api/src/route.ts");
  f.write(path, "unfinished\n");
  const index = f.git("write-tree");
  assert.throws(() => runContractHook({ cwd: f.cwd, generate: () => assert.fail("must not generate") }), /unstaged or untracked/);
  assert.equal(f.git("write-tree"), index);
});

test("a failed generator does not stage partially written output", () => {
  const f = fixture(); f.write("ee/apps/den-api/src/route.ts", "new route\n"); f.git("add", "ee/apps/den-api/src/route.ts");
  assert.throws(() => runContractHook({ cwd: f.cwd, generate: () => {
    f.write("packages/docs/openapi.json", "partial output\n"); throw new Error("generation failed");
  } }), /generation failed/);
  assert.equal(f.git("show", ":packages/docs/openapi.json"), "original\n");
});

test("renaming an API input out of its directory still regenerates", () => {
  const f = fixture(); f.git("mv", "ee/apps/den-api/src/route.ts", "retired-route.ts");
  let ran = false;
  assert.equal(runContractHook({ cwd: f.cwd, generate: () => { ran = true; } }), true);
  assert.equal(ran, true);
});

test("unresolved source conflicts stop before generation", () => {
  const f = fixture(); f.git("switch", "-qc", "left");
  f.write("ee/apps/den-api/src/route.ts", "left route\n"); f.git("commit", "-qam", "left");
  f.git("switch", "-qc", "right", "HEAD~1");
  f.write("ee/apps/den-api/src/route.ts", "right route\n"); f.git("commit", "-qam", "right");
  assert.throws(() => f.git("merge", "--no-edit", "left"));
  assert.throws(() => runContractHook({ cwd: f.cwd, generate: () => assert.fail("must not generate") }), /Resolve source conflicts/);
});

test("installation refuses an existing pre-commit hook", () => {
  const f = fixture(); f.write(".git/hooks/pre-commit", "#!/bin/sh\nexit 0\n");
  assert.throws(() => execFileSync(process.execPath, [fileURLToPath(new URL("../install-git-hooks.mjs", import.meta.url))], { cwd: f.cwd, env: f.env, stdio: "pipe" }));
  assert.equal(readFileSync(join(f.cwd, ".git/hooks/pre-commit"), "utf8"), "#!/bin/sh\nexit 0\n");
});

test("installation is opt-in, local, and repeatable", () => {
  const f = fixture();
  const script = fileURLToPath(new URL("../install-git-hooks.mjs", import.meta.url));
  execFileSync(process.execPath, [script], { cwd: f.cwd, env: f.env, stdio: "pipe" });
  assert.equal(f.git("config", "--local", "core.hooksPath").trim(), ".githooks");
  execFileSync(process.execPath, [script], { cwd: f.cwd, env: f.env, stdio: "pipe" });
  assert.equal(f.git("config", "--local", "core.hooksPath").trim(), ".githooks");
});

test("installation refuses an existing hooksPath", () => {
  const f = fixture(); f.git("config", "core.hooksPath", "existing-hooks");
  const script = new URL("../install-git-hooks.mjs", import.meta.url);
  assert.throws(() => execFileSync(process.execPath, [fileURLToPath(script)], { cwd: f.cwd, env: f.env, stdio: "pipe" }));
  assert.equal(f.git("config", "core.hooksPath").trim(), "existing-hooks");
});
