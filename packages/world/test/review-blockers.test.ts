import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { classifyScriptReceipt, main, parseWorldArgs } from "../src/cli.ts";
import { computeInvocationHash, computeLocalSourceHash } from "../src/script-world.ts";

test("env parser rejects likely secrets and preserves the script argument boundary", () => {
  for (const key of ["TOKEN", "my_secret", "PASSWORD", "API_KEY", "CREDENTIAL", "AUTHORIZATION", "COOKIE", "OPENWORK_WORLD_PLACE"]) {
    assert.equal(parseWorldArgs(["up", "app-web", "--env", key]).kind, "help");
  }
  assert.deepEqual(parseWorldArgs(["up", "app-web", "--env", "APP_MODE", "--place", "local", "--", "--env", "SCRIPT_ARG"]), {
    kind: "up", source: "app-web", place: "local", env: ["APP_MODE"], args: ["--env", "SCRIPT_ARG"],
  });
  for (const flags of [["--json", "--reveal", "--stage", "test"], ["--stage", "test", "--reveal", "--json"]]) {
    assert.deepEqual(parseWorldArgs(["outputs", "app-web", ...flags]), { kind: "outputs", name: "app-web", stage: "test", json: true, reveal: true });
  }
  for (const flags of [["--reveal", "--reveal"], ["--json", "--json"], ["--stage"], ["--unknown"]]) {
    assert.equal(parseWorldArgs(["outputs", "app-web", ...flags]).kind, "help");
  }
});

test("legacy receipt adoption requires unchanged recipe and default local invocation; plan does not verify new identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-legacy-review-"));
  const previous = process.env.OPENWORK_WORLD_SNAPSHOT_DIR;
  const path = join(root, "probe.json");
  const recipe = join(root, "probe.ts");
  const snapshot = { version: 2, kind: "script", name: "probe", createdAt: "now", pid: process.pid, sourcePath: recipe, recipeHash: "same", outputs: {} };
  try {
    await writeFile(path, JSON.stringify(snapshot));
    assert.equal((await classifyScriptReceipt(path, "same", "new", true)).kind, "running");
    assert.equal((await classifyScriptReceipt(path, "same", "new", false)).kind, "changed");
    assert.equal((await classifyScriptReceipt(path, "changed", "new", true)).kind, "changed");
    for (const extra of [{ recipeHash: undefined }, { place: "daytona" }, { invocationHash: "old" }]) {
      await writeFile(path, JSON.stringify({ ...snapshot, ...extra }));
      assert.equal((await classifyScriptReceipt(path, "same", "new", true)).kind, "changed");
    }
    await writeFile(recipe, "export {};");
    const { computeRecipeHash } = await import("../src/script-world.ts");
    await writeFile(path, JSON.stringify({ ...snapshot, recipeHash: await computeRecipeHash(recipe), invocationHash: "recorded" }));
    process.env.OPENWORK_WORLD_SNAPSHOT_DIR = root;
    const lines: string[] = [];
    assert.equal(await main(["plan", recipe], { cwd: root, worldsDirectory: root, print: (line) => lines.push(line) }), 0);
    assert.match(lines.join("\n"), /invocation unverified/);
    assert.doesNotMatch(lines.join("\n"), /attachable/);
  } finally {
    if (previous === undefined) delete process.env.OPENWORK_WORLD_SNAPSHOT_DIR;
    else process.env.OPENWORK_WORLD_SNAPSHOT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("outputs mask secrets unless reveal is explicitly requested in text or JSON", async () => {
  const privateUrl = new URL(["https:", "", ["private", "example", "test"].join(".")].join("/")).origin;
  const root = await mkdtemp(join(tmpdir(), "world-outputs-review-"));
  const previous = process.env.OPENWORK_WORLD_SNAPSHOT_DIR;
  try {
    process.env.OPENWORK_WORLD_SNAPSHOT_DIR = root;
    await writeFile(join(root, "probe.json"), JSON.stringify({ version: 2, kind: "script", name: "probe", createdAt: "now", pid: process.pid,
      sourcePath: "probe.ts", outputs: { webUrl: privateUrl, placement: "daytona" }, outputMeta: { webUrl: { secret: true } } }));
    for (const json of [false, true]) {
      for (const reveal of [false, true]) {
        const lines: string[] = [];
        assert.equal(await main(["outputs", "probe", ...(json ? ["--json"] : []), ...(reveal ? ["--reveal"] : [])],
          { cwd: root, worldsDirectory: root, print: (line) => lines.push(line) }), 0);
        const expected = reveal ? privateUrl : "••••••••";
        if (json) {
          assert.deepEqual(JSON.parse(lines.join("\n")).outputs, {
            webUrl: { value: expected, secret: true }, placement: { value: "daytona", secret: false },
          });
        } else {
          assert.deepEqual(lines, [`webUrl  ${expected}`, "placement  daytona"]);
        }
      }
    }
  } finally {
    if (previous === undefined) delete process.env.OPENWORK_WORLD_SNAPSHOT_DIR;
    else process.env.OPENWORK_WORLD_SNAPSHOT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("local source identity changes for tracked edits, staging and untracked bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-source-review-"));
  const exec = promisify(execFile);
  const git = (args: string[]) => exec("git", args, { cwd: root });
  try {
    assert.equal(await computeLocalSourceHash(root), undefined);
    await git(["init"]);
    await writeFile(join(root, "app.ts"), "initial");
    await git(["add", "app.ts"]);
    await git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "fixture"]);
    const initial = await computeLocalSourceHash(root);
    assert.equal(await computeLocalSourceHash(root), initial);
    await writeFile(join(root, "app.ts"), "changed");
    const edited = await computeLocalSourceHash(root);
    assert.notEqual(edited, initial);
    await git(["add", "app.ts"]);
    assert.notEqual(await computeLocalSourceHash(root), edited);
    await writeFile(join(root, "new.ts"), "first");
    const untracked = await computeLocalSourceHash(root);
    await writeFile(join(root, "new.ts"), "second");
    const changed = await computeLocalSourceHash(root);
    assert.notEqual(changed, untracked);
    assert.notEqual(computeInvocationHash("recipe", [], "local", {}, untracked), computeInvocationHash("recipe", [], "local", {}, changed));
  } finally { await rm(root, { recursive: true, force: true }); }
});
