import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  githubRequest,
  prepareReceipt,
  publishReceipt,
  renderComment,
  validateReceipt,
} from "./warden-review.mjs";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const metadata = {
  repository: "openworklabs/openwork",
  pr: 42,
  head: HEAD,
  base: BASE,
  runId: "123456",
  attempt: 2,
};

function finding(id, severity = "low", confidence = "low", extra = {}) {
  return {
    id,
    severity,
    confidence,
    title: "private title",
    description: "private description",
    location: { path: "apps/app/src/main.ts", startLine: 12 },
    ...extra,
  };
}

function raw(skills = []) {
  const all = skills.flatMap((skill) => skill.findings);
  return {
    version: "1",
    timestamp: "2026-09-09T12:00:00.000Z",
    repository: { owner: "openworklabs", name: "openwork", fullName: "openworklabs/openwork" },
    event: "pull_request",
    pullRequest: {
      number: 42,
      author: "private-author",
      title: "private PR title",
      baseBranch: "dev",
      headBranch: "private-branch",
      headSha: HEAD,
    },
    runId: "123456",
    summary: {
      totalFindings: all.length,
      findingsBySeverity: {
        high: all.filter((item) => item.severity === "high").length,
        medium: all.filter((item) => item.severity === "medium").length,
        low: all.filter((item) => item.severity === "low").length,
      },
      totalSkills: skills.length,
    },
    skills,
    triggerResults: skills.map((report, index) => ({
      triggerId: `trigger-${index}`,
      triggerName: `${report.name}-pull-request`,
      skillName: report.name,
      status: "success",
      report: {
        skill: report.name,
        summary: report.summary,
        findings: report.findings,
        ...(report.durationMs !== undefined && { durationMs: report.durationMs }),
      },
    })),
    findingObservations: [],
  };
}

function skill(name, findings = [], extra = {}) {
  return { name, summary: "private model summary", durationMs: 25, findings, ...extra };
}

test("sanitizes configuration and model-authored free text", () => {
  const input = raw([
    skill("diff-security-review", []),
    skill("confidentiality-review", [finding("CONF-1", "low")]),
  ]);
  const receipt = prepareReceipt(input, metadata);
  const serialized = JSON.stringify(receipt);
  for (const secret of ["private-author", "private PR title", "private-branch", "private model summary", "private title", "private description"]) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.equal(receipt.findings[0].location, undefined);
  assert.equal(receipt.verdict, "blocked");
});

test("applies blocker and advisory policy across severity and confidence", () => {
  const receipt = prepareReceipt(raw([
    skill("diff-security-review", [finding("SEC-LOW", "low", "low")]),
    skill("confidentiality-review", [finding("CONF-MED", "medium", "high")]),
    skill("desktop-den-sync-review", [finding("SYNC-HIGH", "high"), finding("SYNC-MED", "medium")]),
    skill("spec-provenance-review", [finding("PROV-HIGH", "high")]),
  ]), metadata);
  assert.equal(receipt.review_complete, true);
  assert.equal(receipt.blocking_count, 3);
  assert.equal(receipt.sync_advisory_count, 1);
  assert.deepEqual(receipt.findings.map((item) => item.disposition), [
    "blocker", "blocker", "blocker", "advisory", "advisory",
  ]);
});

test("marks partial, error, unknown, and inconsistent reports incomplete", () => {
  const input = raw([
    skill("diff-security-review", [], { failedHunks: 1 }),
    skill("unknown-skill", [finding("UNKNOWN", "urgent")]),
  ]);
  input.summary.totalFindings = 99;
  input.triggerResults = [{
    triggerName: "pull-request",
    skillName: "diff-security-review",
    status: "error",
    error: { message: "private provider failure" },
  }];
  const receipt = prepareReceipt(input, metadata);
  assert.equal(receipt.verdict, "incomplete");
  assert.equal(receipt.review_complete, false);
  assert.ok(receipt.needs_recheck.includes("missing-mandatory-skill:confidentiality-review"));
  assert.ok(receipt.needs_recheck.includes("unknown-severity"));
  assert.ok(receipt.needs_recheck.includes("summary-count-mismatch"));
  assert.equal(JSON.stringify(receipt).includes("private provider failure"), false);
});

test("rejects malformed and trusted-metadata-mismatched input", () => {
  const input = raw([skill("diff-security-review"), skill("confidentiality-review")]);
  delete input.summary;
  assert.throws(() => prepareReceipt(input, metadata), /summary is missing/);
  const valid = raw([skill("diff-security-review"), skill("confidentiality-review")]);
  assert.throws(() => prepareReceipt(valid, { ...metadata, pr: 43 }), /PR does not match/);
});

test("dedupes only a consistent native ID and lets blocking attribution win", () => {
  const shared = finding("SHARED-1", "high", "high");
  const receipt = prepareReceipt(raw([
    skill("diff-security-review", [shared]),
    skill("confidentiality-review", []),
    skill("spec-provenance-review", [{ ...shared }]),
  ]), metadata);
  assert.equal(receipt.findings.length, 1);
  assert.deepEqual(receipt.findings[0].skills, ["diff-security-review", "spec-provenance-review"]);
  assert.equal(receipt.findings[0].disposition, "blocker");
});

test("keeps conflicting native IDs separate and requires a recheck", () => {
  const receipt = prepareReceipt(raw([
    skill("diff-security-review", [finding("CONFLICT", "high")]),
    skill("confidentiality-review", []),
    skill("spec-provenance-review", [finding("CONFLICT", "low")]),
  ]), metadata);
  assert.equal(receipt.findings.length, 2);
  assert.equal(receipt.verdict, "incomplete");
  assert.ok(receipt.needs_recheck.includes("stable-id-conflict"));
});

test("renders bounded identifiers and honest unavailable precision", () => {
  const receipt = prepareReceipt(raw([
    skill("diff-security-review", []),
    skill("confidentiality-review", []),
    skill("spec-provenance-review", [finding("PROV-1")]),
  ]), metadata);
  const metrics = {
    uniqueObservedRunAttempts: 1,
    distinctHeads: 1,
    currentUnresolvedThreads: 0,
    currentObservedThreads: 1,
    observedTransitions: { resolved: 0, unresolved: 0 },
    firstObserved: { resolved: 1, unresolved: 0 },
    precision: null,
    collectionWindow: { retainedRunAttempts: 1, limit: 20, truncated: false },
    threadSnapshot: { retained: 1, observed: 1, limit: 500, truncated: false },
  };
  const body = renderComment(receipt, metrics, { version: 1 }, "https://github.com/openworklabs/openwork/actions/runs/123456");
  assert.match(body, /Precision: \*\*unavailable\*\*/);
  assert.match(body, /PROV-1/);
  assert.equal(body.includes("private title"), false);
});

test("requires a nonempty reconciled replay roster for mandatory skills", () => {
  for (const triggerResults of [undefined, []]) {
    const input = raw([skill("diff-security-review"), skill("confidentiality-review")]);
    input.triggerResults = triggerResults;
    const receipt = prepareReceipt(input, metadata);
    assert.equal(receipt.review_complete, false);
    assert.equal(receipt.verdict, "incomplete");
    assert.ok(receipt.needs_recheck.includes("missing-trigger-results"));
    assert.ok(receipt.needs_recheck.includes("missing-mandatory-trigger:diff-security-review"));
    assert.ok(receipt.needs_recheck.includes("missing-mandatory-trigger:confidentiality-review"));
  }
});

test("rejects contradictory replay reports instead of clearing from empty top-level security", () => {
  const input = raw([skill("diff-security-review"), skill("confidentiality-review")]);
  input.triggerResults[0].report.findings = [finding("HIDDEN-BLOCKER", "high")];
  const receipt = prepareReceipt(input, metadata);
  assert.equal(receipt.verdict, "incomplete");
  assert.ok(receipt.needs_recheck.includes("trigger-report-mismatch:diff-security-review"));

  const wrongSkill = raw([skill("diff-security-review"), skill("confidentiality-review")]);
  wrongSkill.triggerResults[0].report.skill = "confidentiality-review";
  const wrongSkillReceipt = prepareReceipt(wrongSkill, metadata);
  assert.equal(wrongSkillReceipt.verdict, "incomplete");
  assert.ok(wrongSkillReceipt.needs_recheck.includes(
    "trigger-report-skill-mismatch:diff-security-review",
  ));
});

test("accepts multiple native trigger reports for one skill and emits unique coverage", () => {
  const receipt = prepareReceipt(raw([
    skill("diff-security-review", [finding("SEC-A", "high")]),
    skill("diff-security-review", [finding("SEC-B", "low")]),
    skill("confidentiality-review"),
    skill("desktop-den-sync-review", [finding("SYNC-A", "medium")]),
    skill("desktop-den-sync-review", [finding("SYNC-B", "high")]),
  ]), metadata);
  assert.equal(receipt.review_complete, true);
  assert.equal(receipt.findings_count, 4);
  assert.equal(receipt.security_count, 2);
  assert.equal(receipt.sync_advisory_count, 1);
  assert.equal(receipt.sync_blocking_count, 1);
  assert.deepEqual(receipt.coverage.skills.map((item) => item.name), [
    "diff-security-review",
    "confidentiality-review",
    "desktop-den-sync-review",
  ]);
});

test("receipt validation recomputes the minimum policy projection", () => {
  const receipt = prepareReceipt(raw([
    skill("diff-security-review", [finding("SEC-BLOCK", "low")]),
    skill("confidentiality-review"),
  ]), metadata);
  const forgedClear = structuredClone(receipt);
  forgedClear.security_count = 0;
  forgedClear.blocking_count = 0;
  forgedClear.verdict = "clear";
  assert.throws(() => validateReceipt(forgedClear), /policy counts|blockers cannot be clear/);

  const forgedDisposition = structuredClone(receipt);
  forgedDisposition.findings[0].disposition = "advisory";
  assert.throws(() => validateReceipt(forgedDisposition), /disposition is inconsistent/);

  const duplicateCoverage = structuredClone(receipt);
  duplicateCoverage.coverage.skills.push(structuredClone(duplicateCoverage.coverage.skills[0]));
  assert.throws(() => validateReceipt(duplicateCoverage), /coverage skills must be unique/);

  const emptyAttribution = structuredClone(receipt);
  emptyAttribution.findings[0].skills = [];
  assert.throws(() => validateReceipt(emptyAttribution), /finding skills are invalid/);

  const shared = finding("SHARED-POLICY", "medium");
  assert.doesNotThrow(() => validateReceipt(prepareReceipt(raw([
    skill("diff-security-review", [shared]),
    skill("confidentiality-review"),
    skill("desktop-den-sync-review", [{ ...shared }]),
  ]), metadata)));
});

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function clearReceipt() {
  return prepareReceipt(raw([
    skill("diff-security-review"),
    skill("confidentiality-review"),
  ]), metadata);
}

function currentPr(head = HEAD) {
  return {
    number: 42,
    state: "open",
    merged: false,
    merged_at: null,
    head: { sha: head, ref: "feature", repo: { full_name: metadata.repository } },
    base: { sha: BASE, ref: "dev", repo: { full_name: metadata.repository } },
  };
}

function producerRun(overrides = {}) {
  const repo = {
    full_name: metadata.repository,
    url: `https://api.github.com/repos/${metadata.repository}`,
  };
  return {
    id: Number(metadata.runId),
    run_attempt: metadata.attempt,
    run_number: 7,
    event: "pull_request",
    head_sha: HEAD,
    head_branch: "feature",
    repository: repo,
    head_repository: repo,
    status: "completed",
    conclusion: "success",
    path: ".github/workflows/warden.yml",
    pull_requests: [],
    ...overrides,
  };
}

function githubMock({ prs = [currentPr(), currentPr()], run = producerRun(), comments = [], pages } = {}) {
  const requests = [];
  let prRead = 0;
  let graphRead = 0;
  const graphPages = pages ?? [{
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [],
          },
        },
      },
    },
  }];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    const path = new URL(url).pathname;
    if (path.endsWith("/pulls/42") && (options.method ?? "GET") === "GET") {
      return response(prs[Math.min(prRead++, prs.length - 1)]);
    }
    if (path.endsWith(`/actions/runs/${metadata.runId}`)) return response(run);
    if (path.endsWith("/issues/42/comments") && new URL(url).search) return response(comments);
    if (path === "/graphql") return response(graphPages[Math.min(graphRead++, graphPages.length - 1)]);
    if (path.endsWith("/issues/42/comments") && options.method === "POST") return response({ id: 9001 });
    if (path.includes("/issues/comments/") && options.method === "PATCH") return response({ id: 9002 });
    throw new Error(`unexpected GitHub request: ${options.method ?? "GET"} ${url}`);
  };
  return { fetchImpl, requests };
}

test("GitHub requests have a bounded timeout", async () => {
  const never = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
  });
  await assert.rejects(
    githubRequest(never, "https://api.github.test/rate_limit", "token", { timeoutMs: 5 }),
    /timed out|timeout|aborted/i,
  );
});

test("publisher attributes only exact bot markers and counts unique thread IDs", async () => {
  const marker = "<!-- warden:finding:v1:eyJpZCI6IlNFQy0xIiwic2V2ZXJpdHkiOiJsb3cifQ -->";
  const spoofedSummary = {
    id: 1,
    user: { login: "human", type: "User" },
    body: "<!-- openwork:warden-review-summary:v1 -->",
  };
  const nodes = [
    { id: "human", isResolved: true, comments: { nodes: [{ body: marker, author: { login: "human", __typename: "User" } }] } },
    { id: "rest-style-login", isResolved: true, comments: { nodes: [{ body: marker, author: { login: "github-actions[bot]", __typename: "Bot" } }] } },
    { id: "generic", isResolved: true, comments: { nodes: [{ body: "warden:finding", author: { login: "github-actions", __typename: "Bot" } }] } },
    { id: "thread-1", isResolved: false, comments: { nodes: [{ body: marker, author: { login: "github-actions", __typename: "Bot" } }] } },
    { id: "thread-1", isResolved: true, comments: { nodes: [{ body: marker, author: { login: "github-actions", __typename: "Bot" } }] } },
  ];
  const mock = githubMock({
    comments: [spoofedSummary],
    pages: [{ data: { repository: { pullRequest: { reviewThreads: {
      pageInfo: { hasNextPage: false, endCursor: null }, nodes,
    } } } } }],
  });
  const result = await publishReceipt(clearReceipt(), {
    env: { GITHUB_TOKEN: "token" },
    fetchImpl: mock.fetchImpl,
  });
  assert.equal(result.status, "published");
  assert.equal(result.metrics.currentObservedThreads, 1);
  assert.equal(result.metrics.currentUnresolvedThreads, 0);
  const write = mock.requests.find((request) => request.options.method === "POST" &&
    new URL(request.url).pathname.endsWith("/issues/42/comments"));
  assert.ok(write);
  assert.match(JSON.parse(write.options.body).body,
    /First observed resolved\/unresolved \(state at first collection, not event time\): \*\*1 \/ 0\*\*/);
  assert.equal(mock.requests.some((request) => request.options.method === "PATCH"), false);
});

test("publisher rechecks current PR identity immediately before writing", async () => {
  const mock = githubMock({ prs: [currentPr(), currentPr("c".repeat(40))] });
  const result = await publishReceipt(clearReceipt(), {
    env: { GITHUB_TOKEN: "token" },
    fetchImpl: mock.fetchImpl,
  });
  assert.deepEqual(result, { status: "stale", verdict: "clear", metrics: null });
  assert.equal(mock.requests.some((request) => ["POST", "PATCH"].includes(request.options.method) &&
    new URL(request.url).pathname !== "/graphql"), false);

  for (const stalePr of [
    { ...currentPr(), state: "closed" },
    { ...currentPr(), merged: true, merged_at: "2026-09-09T12:00:00Z" },
  ]) {
    const closedOrMerged = githubMock({ prs: [stalePr] });
    const staleResult = await publishReceipt(clearReceipt(), {
      env: { GITHUB_TOKEN: "token" },
      fetchImpl: closedOrMerged.fetchImpl,
    });
    assert.deepEqual(staleResult, { status: "stale", verdict: "clear", metrics: null });
    assert.equal(closedOrMerged.requests.length, 1);
  }
});

test("publisher rejects malformed GraphQL pagination without mutating a comment", async () => {
  const missingPageInfo = githubMock({
    pages: [{ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }],
  });
  await assert.rejects(
    publishReceipt(clearReceipt(), { env: { GITHUB_TOKEN: "token" }, fetchImpl: missingPageInfo.fetchImpl }),
    /pageInfo is invalid/,
  );
  assert.equal(missingPageInfo.requests.some((request) => request.options.method === "PATCH" ||
    (request.options.method === "POST" && new URL(request.url).pathname !== "/graphql")), false);

  const repeatedCursor = githubMock({ pages: [
    { data: { repository: { pullRequest: { reviewThreads: {
      nodes: [], pageInfo: { hasNextPage: true, endCursor: "same" },
    } } } } },
    { data: { repository: { pullRequest: { reviewThreads: {
      nodes: [], pageInfo: { hasNextPage: true, endCursor: "same" },
    } } } } },
  ] });
  await assert.rejects(
    publishReceipt(clearReceipt(), { env: { GITHUB_TOKEN: "token" }, fetchImpl: repeatedCursor.fetchImpl }),
    /cursor did not advance/,
  );
});

test("publisher binds the receipt to trusted outer workflow metadata before API reads", async () => {
  const mock = githubMock();
  await assert.rejects(publishReceipt(clearReceipt(), {
    env: {
      GITHUB_TOKEN: "token",
      WARDEN_EXPECTED_REPOSITORY: metadata.repository,
      WARDEN_EXPECTED_RUN_ID: "999",
      WARDEN_EXPECTED_RUN_ATTEMPT: String(metadata.attempt),
      WARDEN_EXPECTED_HEAD_SHA: HEAD,
    },
    fetchImpl: mock.fetchImpl,
  }), /trusted workflow metadata/);
  assert.equal(mock.requests.length, 0);
});

test("publisher rejects non-repository-qualified producer associations", async () => {
  const foreign = "other/repository";
  const foreignRepo = { full_name: foreign, url: `https://api.github.com/repos/${foreign}` };
  const run = producerRun({ pull_requests: [{
    number: 42,
    url: `https://api.github.com/repos/${foreign}/pulls/42`,
    head: { sha: HEAD, repo: foreignRepo },
    base: { sha: BASE, repo: foreignRepo },
  }] });
  const mock = githubMock({ run });
  await assert.rejects(
    publishReceipt(clearReceipt(), { env: { GITHUB_TOKEN: "token" }, fetchImpl: mock.fetchImpl }),
    /repository-qualified/,
  );
  assert.equal(mock.requests.some((request) => request.options.method === "PATCH" ||
    (request.options.method === "POST" && new URL(request.url).pathname !== "/graphql")), false);
});

const clearanceWorkflow = readFileSync(
  new URL("../workflows/warden-clearance.yml", import.meta.url),
  "utf8",
);

test("clearance workflow isolates the untrusted receipt from the trusted checkout", () => {
  assert.match(clearanceWorkflow,
    /path: \$\{\{ runner\.temp \}\}\/warden-summary-artifact/);
  assert.match(clearanceWorkflow,
    /RECEIPT_PATH: \$\{\{ runner\.temp \}\}\/warden-summary-artifact\/warden-summary\.json/);
  assert.match(clearanceWorkflow,
    /\[ ! -f "\$RECEIPT_PATH" \] \|\| \[ -L "\$RECEIPT_PATH" \]/);
  assert.match(clearanceWorkflow,
    /node "\$GITHUB_WORKSPACE\/\.github\/scripts\/warden-review\.mjs" publish --receipt "\$RECEIPT_PATH"/);
  assert.doesNotMatch(clearanceWorkflow,
    /node \.github\/scripts\/warden-review\.mjs publish --receipt warden-summary\.json/);
});

test("clearance workflow fails closed before guard matching and revokes every app approval", () => {
  const guardStart = clearanceWorkflow.indexOf("changed_files=\"");
  const guardMatch = clearanceWorkflow.indexOf("guarded=\"");
  assert.ok(guardStart >= 0 && guardMatch > guardStart);
  const changedFilesCommand = clearanceWorkflow.slice(guardStart, guardMatch);
  assert.match(changedFilesCommand,
    /gh api --paginate "repos\/\$REPO\/pulls\/\$pr\/files\?per_page=100"/);
  assert.equal(changedFilesCommand.includes("|| true"), false);
  assert.match(clearanceWorkflow.slice(guardMatch), /<<< "\$changed_files" \|\| true/);

  const revoke = clearanceWorkflow.slice(clearanceWorkflow.indexOf("- name: Revoke stale clearance"));
  assert.match(revoke,
    /gh api --paginate "repos\/\$REPO\/pulls\/\$PR\/reviews\?per_page=100"/);
  assert.match(revoke, /\[ -z "\$APP_SLUG" \]/);
  assert.match(revoke, /\.user\.login == .*\[bot\].*\.user\.type == .*Bot.*\.state == .*APPROVED/);
  assert.match(revoke, /while IFS= read -r rid;/);
  assert.doesNotMatch(revoke, /\| last|\|\| echo "Could not dismiss/);
});
