import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { symlinkSync } from "node:fs";
import {
  annotations, filesToReview, fingerprintPatch, fingerprints, mergeBase, mergeFindings, planReview, quickConfig, renderSummary,
  runWarden, securityFrom, trustedWorkspace, validBaseline, wardenEnvironment,
} from "./warden-fast.mjs";

const patch = (body, header = "diff --git a/f b/f\nindex 1111111..2222222 100644\n--- a/f\n+++ b/f") => `${header}\n${body}\n`;

test("fingerprints ignore line numbers, context and blob ids", () => {
  const a = fingerprintPatch(patch("@@ -10,0 +11,2 @@\n+one\n+two"));
  const b = fingerprintPatch(patch("@@ -40,0 +41,2 @@\n+one\n+two", "diff --git a/f b/f\nindex 3333333..4444444 100644\n--- a/f\n+++ b/f"));
  assert.equal(a, b);
  assert.notEqual(a, fingerprintPatch(patch("@@ -10,0 +11,2 @@\n+one\n+three")));
});

test("fingerprints count removed lines that look like diff headers", () => {
  const removed = fingerprintPatch(patch("@@ -1 +0,0 @@\n--- not a header"));
  assert.notEqual(removed, fingerprintPatch(patch("@@ -1 +0,0 @@\n-other")));
});

test("fingerprints track mode changes and binary blobs", () => {
  const plain = fingerprintPatch("diff --git a/s b/s\nold mode 100644\nnew mode 100755\n");
  assert.notEqual(plain, fingerprintPatch("diff --git a/s b/s\nold mode 100644\nnew mode 100644\n"));
  const binary = (ids) => fingerprintPatch(`diff --git a/i.png b/i.png\nindex ${ids} 100644\nBinary files a/i.png and b/i.png differ\n`);
  assert.notEqual(binary("aaa..bbb"), binary("aaa..ccc"));
});

test("a dev merge that leaves the PR's own change alone keeps its fingerprint", () => {
  const dir = mkdtempSync(join(tmpdir(), "warden-fast-"));
  const run = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  try {
    run("init", "-q", "-b", "dev");
    run("config", "user.email", "test@example.com");
    run("config", "user.name", "Test");
    writeFileSync(join(dir, "app.js"), Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n") + "\n");
    writeFileSync(join(dir, "other.js"), "base\n");
    run("add", ".");
    run("commit", "-qm", "base");
    run("checkout", "-qb", "feature");
    writeFileSync(join(dir, "app.js"), Array.from({ length: 40 }, (_, i) => i === 30 ? "line 30 changed" : `line ${i}`).join("\n") + "\n");
    run("commit", "-qam", "feature");
    const before = fingerprints(dir, mergeBase(dir, "dev", "HEAD"), run("rev-parse", "HEAD"));
    // dev edits far from the PR's change and in another file.
    run("checkout", "-q", "dev");
    writeFileSync(join(dir, "app.js"), Array.from({ length: 40 }, (_, i) => i === 2 ? "line 2 from dev" : `line ${i}`).join("\n") + "\n");
    writeFileSync(join(dir, "other.js"), "dev\n");
    run("commit", "-qam", "dev");
    run("checkout", "-q", "feature");
    run("merge", "-q", "--no-edit", "dev");
    const after = fingerprints(dir, mergeBase(dir, "dev", "HEAD"), run("rev-parse", "HEAD"));
    assert.deepEqual(after, before);
    // A further edit to the PR's own change moves only that file.
    writeFileSync(join(dir, "new.js"), "x\n");
    run("add", "new.js");
    run("commit", "-qm", "more");
    const later = fingerprints(dir, mergeBase(dir, "dev", "HEAD"), run("rev-parse", "HEAD"));
    assert.deepEqual(planReview(before, later, { minFiles: 0 }).moved, ["new.js"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("planning picks partial, carry and fallbacks", () => {
  const files = (n, value = "a") => Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}.ts`, value]));
  const before = files(20);
  assert.equal(planReview(before, files(5)).mode, "small");
  assert.equal(planReview(null, files(20)).mode, "no-baseline");
  assert.equal(planReview(before, files(20)).mode, "carry");
  assert.deepEqual(planReview(before, { ...files(20), "f3.ts": "b" }), { mode: "partial", moved: ["f3.ts"], removed: [] });
  assert.equal(planReview(before, files(20, "b")).mode, "too-many");
  assert.equal(planReview(before, { ...files(20), "src/*.ts": "b" }).mode, "unsupported-path");
  const fewer = files(19);
  assert.deepEqual(planReview(before, fewer).removed, ["f19.ts"]);
});

test("the quick config limits every skill to the moved files and keeps CI strictness", () => {
  const policy = [
    "version = 1", "", "[defaults]", 'defaultBranch = "dev"', "", "[[skills]]", 'name = "diff-security-review"', "",
    "[[skills.triggers]]", 'type = "local"', 'minConfidence = "low"', "", "[[skills]]", 'name = "confidentiality-review"', "",
  ].join("\n");
  const config = quickConfig(policy, ["a b.ts", 'we"ird.ts']);
  assert.equal(config.match(/^paths = \["a b\.ts", "we\\"ird\.ts"\]$/gm).length, 2);
  assert.doesNotMatch(config, /minConfidence/);
  assert.equal(quickConfig(policy.replace(/name = "confidentiality-review"/, 'name = "confidentiality-review"\npaths = ["x"]'), ["a"]), null);
  assert.equal(quickConfig("version = 1\n", ["a"]), null);
});

test("the quick config parses with the repository's real policy", () => {
  const policy = execFileSync("git", ["show", "HEAD:warden.toml"], { encoding: "utf8" });
  const config = quickConfig(policy, ["packages/x.ts"]);
  assert.ok(config);
  assert.equal(config.match(/^paths = \["packages\/x\.ts"\]$/gm).length, policy.match(/^\[\[skills\]\]$/gm).length);
});

test("findings for moved or removed files are replaced; the rest carry over", () => {
  const old = [
    { severity: "low", title: "kept", description: "", path: "same.ts", line: 1 },
    { severity: "high", title: "moved", description: "", path: "moved.ts", line: 1 },
    { severity: "medium", title: "gone", description: "", path: "gone.ts", line: 1 },
    { severity: "medium", title: "pathless", description: "", path: null, line: null },
  ];
  const fresh = [{ severity: "high", title: "new", description: "", path: "moved.ts", line: 9 }];
  const merged = mergeFindings(old, fresh, { moved: ["moved.ts"], removed: ["gone.ts"] });
  assert.deepEqual(merged.map((f) => [f.title, f.source]), [["new", "new"], ["pathless", "carried"], ["kept", "carried"]]);
});

test("files with open findings are rechecked whenever anything moved", () => {
  const current = { "a.ts": "1", "b.yml": "1", "c.ts": "1" };
  const previous = [
    { severity: "high", title: "token", description: "", path: "b.yml", line: 1 },
    { severity: "low", title: "nit", description: "", path: "c.ts", line: 1 },
    { severity: "high", title: "gone", description: "", path: "deleted.ts", line: 1 },
  ];
  const open = (finding) => finding.severity !== "low";
  assert.deepEqual(filesToReview({ moved: ["a.ts"] }, previous, current, open), ["a.ts", "b.yml"]);
  assert.deepEqual(filesToReview({ moved: [] }, previous, current, open), []);
});

test("the quick config is written outside the analyzed checkout, so a symlink can't redirect it", () => {
  const dir = mkdtempSync(join(tmpdir(), "warden-config-"));
  try {
    const checkout = join(dir, "pr");
    const outDir = join(dir, "out");
    mkdirSync(checkout);
    writeFileSync(join(dir, "victim"), "untouched\n");
    symlinkSync(join(dir, "victim"), join(checkout, ".warden-quick.toml"));
    // A stand-in CLI that records the config it was given.
    const fake = join(dir, "warden.mjs");
    writeFileSync(fake, `import { writeFileSync } from "node:fs"; const i = process.argv.indexOf("--config-path"); writeFileSync(${JSON.stringify(join(dir, "seen"))}, process.argv[i + 1]);`);
    const policy = execFileSync("git", ["show", "HEAD:warden.toml"], { encoding: "utf8" });
    const parsed = runWarden({ cwd: checkout, wardenBin: fake, policy, files: ["a.ts"], base: "a", head: "b", env: process.env, outDir });
    assert.equal(parsed.complete, false);
    assert.equal(readFileSync(join(dir, "victim"), "utf8"), "untouched\n");
    assert.equal(readFileSync(join(dir, "seen"), "utf8"), join(outDir, "warden-quick.toml"));
    assert.equal(readdirSync(outDir).includes("warden-quick.toml"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("security findings come only from the security skill", () => {
  const found = securityFrom({ findings: [
    { skill: "diff-security-review", severity: "high", title: "t", description: "d", location: { path: "a.ts", startLine: 3 } },
    { skill: "confidentiality-review", severity: "high", title: "secret", description: "name", location: { path: "b.ts", startLine: 1 } },
  ] });
  assert.deepEqual(found, [{ severity: "high", title: "t", description: "d", path: "a.ts", line: 3 }]);
});

test("baselines must belong to the run, PR and commit they claim", () => {
  const run = { id: 7, head_sha: "a".repeat(40) };
  const artifact = { schema_version: 1, complete: true, repository: "o/r", pr: 1, head_sha: "a".repeat(40), run_id: "7", total: 0, findings: [] };
  assert.equal(validBaseline(artifact, run, { repository: "o/r", pr: 1 }), true);
  assert.equal(validBaseline({ ...artifact, complete: false }, run, { repository: "o/r", pr: 1 }), false);
  assert.equal(validBaseline({ ...artifact, pr: 2 }, run, { repository: "o/r", pr: 1 }), false);
  assert.equal(validBaseline({ ...artifact, head_sha: "b".repeat(40) }, run, { repository: "o/r", pr: 1 }), false);
  assert.equal(validBaseline({ ...artifact, findings: [{ severity: "critical" }] }, run, { repository: "o/r", pr: 1 }), false);
});

test("annotations escape workflow commands and mark high findings as errors", () => {
  const [line] = annotations([{ severity: "high", title: "a%b\n::set-output", description: "x", path: "p,q:r.ts", line: 4, source: "new" }]);
  assert.match(line, /^::error file=p%2Cq%3Ar\.ts,line=4,title=Warden quick review \(high\)::a%25b%0A::set-output/);
  assert.equal(annotations([{ severity: "low", title: "t", description: "", path: null }]).length, 0);
});

test("annotations and stored findings redact credential-shaped text", () => {
  const token = `ghs_${"a".repeat(36)}`;
  const [line] = annotations([{ severity: "medium", title: `leak ${token}`, description: `sk-${"b".repeat(40)}`, path: "a.ts", line: 1, source: "new" }]);
  assert.doesNotMatch(line, /ghs_|sk-b/);
  assert.match(line, /\[redacted\]/);
  const [stored] = securityFrom({ findings: [{ skill: "diff-security-review", severity: "high", title: token, description: token, location: null }] });
  assert.equal(stored.title, "[redacted]");
});

test("Warden's agent never receives GitHub tokens", () => {
  const env = wardenEnvironment({ GH_TOKEN: "x", GITHUB_TOKEN: "y", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "z", WARDEN_OPENAI_API_KEY: "k", PATH: "/bin" });
  assert.deepEqual(env, { WARDEN_OPENAI_API_KEY: "k", PATH: "/bin" });
});

test("local reviews take the policy, skills and model catalog from dev, not the branch", () => {
  const dir = mkdtempSync(join(tmpdir(), "warden-trusted-"));
  const run = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  const write = (file, text) => { mkdirSync(join(dir, file, ".."), { recursive: true }); writeFileSync(join(dir, file), text); };
  try {
    run("init", "-q", "-b", "dev");
    run("config", "user.email", "test@example.com");
    run("config", "user.name", "Test");
    write("warden.toml", "trusted policy\n");
    write(".warden/skills/s/SKILL.md", "trusted skill\n");
    write(".warden/pi/models.json", '{"baseUrl":"https://api.openai.com"}\n');
    write("app.js", "x\n");
    run("add", ".");
    run("commit", "-qm", "base");
    run("checkout", "-qb", "feature");
    write("warden.toml", "steered policy\n");
    write(".warden/pi/models.json", '{"baseUrl":"https://attacker.example"}\n');
    write("app.js", "y\n");
    run("commit", "-qam", "branch");
    const workspace = trustedWorkspace(dir, "dev", run("rev-parse", "HEAD"));
    try {
      assert.equal(readFileSync(join(workspace.dir, "warden.toml"), "utf8"), "trusted policy\n");
      assert.match(readFileSync(join(workspace.dir, ".warden/pi/models.json"), "utf8"), /api\.openai\.com/);
      assert.equal(readFileSync(join(workspace.dir, ".warden/skills/s/SKILL.md"), "utf8"), "trusted skill\n");
      // The branch's own files are not checked out; Warden reads them from git objects.
      assert.equal(existsSync(join(workspace.dir, "app.js")), false);
      assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace.dir, encoding: "utf8" }).trim(), run("rev-parse", "HEAD"));
    } finally {
      workspace.cleanup();
    }
    assert.equal(existsSync(workspace.dir), false);
    assert.doesNotMatch(run("worktree", "list"), /warden-quick-/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the pre-push hook runs the reviewer from origin/dev, never the pushed branch", () => {
  const hook = readFileSync(join(process.cwd(), ".githooks", "pre-push"), "utf8");
  assert.match(hook, /git show "\$ref:\.github\/scripts\/\$file"/);
  assert.doesNotMatch(hook, /node \.github\/scripts\/warden-fast\.mjs/);
});

test("the summary never shows confidentiality text and escapes model output", () => {
  const text = renderSummary({
    plan: { mode: "partial", moved: ["a.ts"], removed: [] }, total: 20, complete: true, confidentiality: 1, omitted: 2,
    findings: [{ severity: "high", title: "<b>@team</b>", description: "", path: "a.ts", line: 2, source: "new" }],
  });
  assert.match(text, /Re-reviewed 1 of 20 files/);
  assert.match(text, /1 confidentiality finding\(s\)/);
  assert.match(text, /&lt;b&gt;@\u200bteam&lt;\/b&gt;/);
  assert.match(text, /2 more finding\(s\)/);
  assert.match(renderSummary({ plan: { mode: "small" } }), /already quick/);
});

test("the pre-push hook is a no-op unless opted in", () => {
  const dir = mkdtempSync(join(tmpdir(), "warden-hook-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    const hook = join(process.cwd(), ".githooks", "pre-push");
    chmodSync(hook, 0o755);
    const out = execFileSync(hook, ["origin", "url"], { cwd: dir, input: "", encoding: "utf8" });
    assert.equal(out, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
