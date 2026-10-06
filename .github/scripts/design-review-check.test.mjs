import assert from "node:assert/strict";
import test from "node:test";
import { inert, renderDesignCheck, upsertDesignCheck, validateDesignDigest } from "./design-review-check.mjs";
import { presentEvidence } from "./evidence-presentation.mjs";

const sha = "a".repeat(40), repo = "sample-org/sample-project";
const reportUrl = `https://review.example.test/r/${"b".repeat(32)}`;
const note = {
  rule: "layout.split-row", severity: "medium", source: "layout",
  title: "Columns drift away from their rows",
  detail: "9 rows leave a 405–845px hole between “What it does” … “Kind”.",
  step: "after: at 1920 wide every row has its own columns",
  spec: "evals/specs/library-list-on-wide-screens.e2e.test.ts",
  anchors: ['[data-library-row="docs-helper"]'], classes: ["w-[150px] md:w-[190px]"],
};

test("each note says what is wrong, where in the code, and how to reproduce it", () => {
  const digest = validateDesignDigest({ reviewed: 1, notes: [note] });
  const check = renderDesignCheck({ sha, digest });
  assert.equal(check.conclusion, "neutral");
  assert.equal(check.title, "1 design note, 1 worth fixing");
  assert.match(check.text, /### 1\. Columns drift away from their rows/);
  assert.match(check.text, /Where in the code: `\[data-library-row="docs-helper"\]` · class `w-\[150px\] md:w-\[190px\]`/);
  assert.match(check.text, /Reproduce: `pnpm evals:e2e library-list-on-wide-screens --local && pnpm --dir evals design:review -- --test-run latest --json`/);
  assert.match(check.text, /```json\n\[/);
  const clean = renderDesignCheck({ sha, digest: validateDesignDigest({ reviewed: 2, notes: [] }) });
  assert.equal(clean.conclusion, "success");
  assert.equal(clean.title, "No design notes");
  assert.equal(clean.text, undefined);
});

test("text from the page or the model can never become a link, an image, a mention or HTML", () => {
  const hostile = { ...note, title: "[Approve](https://evil.example/x) ![i](https://evil.example/i.png) @octocat <img src=x>",
    detail: "``` break out ``` and `code`", anchors: ["`]); alert(1)"], spec: "evals/specs/../../.github/x.test.ts" };
  const check = renderDesignCheck({ sha, digest: validateDesignDigest({ reviewed: 1, notes: [hostile] }) });
  assert.doesNotMatch(check.text.split("<details>")[0], /\]\(https:\/\//);
  assert.match(check.text, /\\\[Approve\\\]\\\(https:\u200b\/\/evil\.example\/x\\\)/);
  assert.match(check.text, /@\u200boctocat/);
  assert.match(check.text, /\\<img src=x\\>/);
  assert.doesNotMatch(check.text, /``` break out/);
  assert.doesNotMatch(check.text, /\.github\/x\.test\.ts/);
  assert.equal(inert("@a"), "@\u200ba");
  const started = performance.now();
  inert(`${"\n".repeat(50_000)}x`);
  validateDesignDigest({ reviewed: 1, notes: [{ ...note, spec: `evals/specs/${"a".repeat(100_000)}` }] });
  assert.ok(performance.now() - started < 1_000);
});

test("only the publisher's shape is accepted: bad rules are dropped and long lists are capped", () => {
  assert.equal(validateDesignDigest("notes"), undefined);
  assert.equal(validateDesignDigest({ reviewed: -1, notes: [] }), undefined);
  const digest = validateDesignDigest({ reviewed: 1, notes: [{ ...note, rule: "not a rule" }, { ...note, severity: "high" }, ...Array.from({ length: 70 }, () => note)] });
  assert.equal(digest.notes.length, 58);
  assert.equal(digest.truncated, true);
});

test("the check is created once per run and updated in place on a re-publish", async () => {
  const writes = [];
  let existing = [];
  const api = async (path, method = "GET", body) => {
    if (method !== "GET") { writes.push({ path, method, body }); return { id: 77 }; }
    return { total_count: existing.length, check_runs: existing };
  };
  const digest = validateDesignDigest({ reviewed: 1, notes: [note] });
  const created = await upsertDesignCheck({ repo, sha, runId: 30, runAttempt: 1, detailsUrl: reportUrl, digest }, api);
  assert.deepEqual(created, { id: 77, count: 1, worthFixing: 1 });
  assert.equal(writes[0].method, "POST");
  assert.equal(writes[0].body.name, "Design review");
  assert.equal(writes[0].body.external_id, "design:30:1");
  existing = [{ id: 77, name: "Design review", external_id: "design:30:1", app: { slug: "github-actions" } }];
  await upsertDesignCheck({ repo, sha, runId: 30, runAttempt: 1, detailsUrl: reportUrl, digest }, api);
  assert.equal(writes[1].method, "PATCH");
  assert.ok(writes[1].path.endsWith("/check-runs/77"));
});

function publication(design) {
  const source = { id: 30, run_attempt: 1, workflow_id: 20, path: ".github/workflows/pr-proof.yml", name: "PR change proof", event: "pull_request", status: "completed", conclusion: "success", head_sha: sha,
    repository: { id: 10, full_name: repo }, head_repository: { id: 10, full_name: repo },
    pull_requests: [{ number: 7, head: { sha, repo: { id: 10 } }, base: { repo: { id: 10 } } }] };
  const pr = { state: "open", head: { sha, repo: { id: 10 } }, base: { repo: { id: 10 } } };
  const writes = [];
  const api = async (path, method = "GET", body) => {
    if (method !== "GET") { writes.push({ path, method, body }); return { id: path.endsWith("deployments") ? 50 : 40 }; }
    if (path.endsWith("/actions/runs/30")) return source;
    if (path.endsWith("/workflows/pr-proof.yml")) return { id: 20, path: source.path };
    if (path.endsWith("/pulls/7")) return pr;
    if (path.includes("/workflows/20/runs?")) return { total_count: 1, workflow_runs: [source] };
    if (path.includes("/comments?")) return [];
    if (path.includes("/deployments?")) return [];
    if (path.includes("/check-runs?")) return { total_count: 0, check_runs: [] };
    throw new Error(path);
  };
  const input = { repo, runId: 30, runAttempt: 1, phase: "complete", reviewUrl: "https://review.example.test",
    receipt: { state: "published", reportUrl, evidence: { gitSha: sha, verdict: "Passed", tests: 1, passedTests: 1, assertions: 2, passedAssertions: 2 }, design } };
  return { api, input, writes };
}

test("a published report gets a Design review check and one card line, and the evidence verdict is unchanged", async () => {
  const f = publication({ reviewed: 1, notes: [note] });
  await presentEvidence(f.input, f.api);
  assert.equal(f.writes[0].body.name, "Evidence preview");
  assert.equal(f.writes[0].body.conclusion, "success");
  const design = f.writes.find(write => write.body?.name === "Design review");
  assert.equal(design.body.conclusion, "neutral");
  assert.equal(design.body.details_url, reportUrl);
  const card = f.writes.find(write => write.path.endsWith("/issues/7/comments")).body.body;
  assert.match(card, /Design review: 1 note, 1 worth fixing · \[Read the notes\]\(https:\/\/github\.com\/sample-org\/sample-project\/runs\/40\)/);
});

test("a malformed or missing digest adds no Design review check and never fails the evidence", async () => {
  for (const design of [undefined, "1 note", { reviewed: "1", notes: [] }]) {
    const f = publication(design);
    await presentEvidence(f.input, f.api);
    assert.equal(f.writes[0].body.conclusion, "success");
    assert.equal(f.writes.some(write => write.body?.name === "Design review"), false);
  }
});
