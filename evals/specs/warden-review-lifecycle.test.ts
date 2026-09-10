import { expect } from "vitest";
import { test } from "@openwork/testkit";
import { wardenReviewLifecycle } from "../worlds/warden-review-lifecycle.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Expected ${label} to be an object.`);
  }
  return value;
}

test("A contributor can publish and safely refresh a Warden PR review report", { timeout: 120_000 }, async ({ evidence }) => {
  await using world = await wardenReviewLifecycle();

  const advisory = await world.prepare("advisory");
  expect(advisory.result.code).toBe(0);
  expect(advisory.result.stderr).toBe("");
  expect(advisory.receipt).toMatchObject({
    findings_count: 2,
    high_count: 0,
    blocking_count: 0,
    security_count: 0,
    sync_blocking_count: 0,
    sync_advisory_count: 1,
    review_complete: true,
  });
  expect(JSON.stringify(advisory.receipt)).not.toContain(world.privateMarker);
  expect(advisory.receipt?.verdict).toBe("clear");
  world.seedRun(advisory, 7);

  const firstPublish = await world.publish(advisory);
  const firstJson = record(firstPublish.json, "first publish output");
  const firstMetrics = record(firstJson.metrics, "first publish metrics");
  const firstBotSummaries = world.comments().filter((comment) =>
    comment.user.login === "github-actions[bot]" && comment.body.includes("openwork:warden-review-summary"),
  );
  const spoof = world.comments().find((comment) => comment.id === 100);
  expect(firstPublish.code).toBe(0);
  expect(firstBotSummaries).toHaveLength(1);
  expect(firstBotSummaries[0]?.body).toContain("### Advisories\n- <code>SYNC-ADVISORY</code>");
  expect(firstBotSummaries[0]?.body).toContain("<code>PROV-ADVISORY</code>");
  expect(firstBotSummaries[0]?.body).toContain("### Blockers\n- None.");
  expect(firstBotSummaries[0]?.body).toContain("https://github.example.invalid/openworklabs/openwork/actions/runs/123456");
  expect(firstBotSummaries[0]?.body).toContain("this summary is not clearance authority");
  expect(firstBotSummaries[0]?.body).toContain("state at first collection, not event time");
  expect(firstBotSummaries[0]?.body).not.toContain(world.privateMarker);
  expect(spoof).toMatchObject({
    id: 100,
    body: expect.stringContaining("spoofed summary must remain human-owned"),
    user: { login: "fixture-human", type: "User" },
  });
  expect(world.writes()).toHaveLength(1);
  expect(world.writes()[0]).toMatchObject({
    method: "POST",
    path: "/repos/openworklabs/openwork/issues/42/comments",
    authorization: "Bearer test-token",
  });
  expect(world.requests().some((request) => request.url.includes("page=2"))).toBe(true);
  expect(world.reviewMutations()).toEqual([]);
  expect(firstMetrics).toMatchObject({
    uniqueObservedRunAttempts: 1,
    distinctHeads: 1,
    currentUnresolvedThreads: 1,
    currentObservedThreads: 2,
    observedTransitions: { resolved: 0, unresolved: 0 },
    firstObserved: { resolved: 1, unresolved: 1 },
    precision: null,
    collectionWindow: { retainedRunAttempts: 1, limit: 20, truncated: false },
    threadSnapshot: { retained: 2, observed: 2, limit: 500, truncated: false },
  });
  expect(firstJson.status).toBe("published");
  expect(firstJson.verdict).toBe("clear");
  evidence.recordAssertionEvidence(
    "Advisory findings publish one redacted ordinary PR summary",
    "The production CLI classified medium sync and provenance findings as advisories, created one bot-owned issue comment after scanning both comment pages, labeled the summary as non-clearance authority, left a spoofed human summary unchanged, and made no review, approval, dismissal, or thread mutation. Clear is Warden analysis, not GitHub mergeability.",
    true,
  );

  const writesAfterFirst = world.writes().length;
  const graphReadsAfterFirst = world.requests().filter((request) => request.path === "/graphql").length;
  const repeated = await world.publish(advisory);
  const repeatedJson = record(repeated.json, "repeated publish output");
  expect(repeated.code).toBe(0);
  expect(world.writes()).toHaveLength(writesAfterFirst);
  expect(world.comments().filter((comment) =>
    comment.user.login === "github-actions[bot]" && comment.body.includes("openwork:warden-review-summary"),
  )).toHaveLength(1);
  expect(world.requests().filter((request) => request.path === "/graphql")).toHaveLength(graphReadsAfterFirst);
  expect(repeatedJson.metrics).toEqual(firstMetrics);
  expect(world.reviewMutations()).toEqual([]);
  expect(repeatedJson.status).toBe("published");
  expect(repeatedJson.verdict).toBe("clear");

  const mixed = await world.prepare("mixed", { attempt: 2 });
  expect(mixed.result.code).toBe(0);
  expect(mixed.receipt).toMatchObject({
    findings_count: 3,
    high_count: 1,
    blocking_count: 3,
    security_count: 2,
    sync_blocking_count: 1,
    sync_advisory_count: 0,
    review_complete: true,
  });
  expect(JSON.stringify(mixed.receipt)).not.toContain(world.privateMarker);
  expect(mixed.receipt?.verdict).toBe("blocked");
  world.seedRun(mixed, 7);
  const mixedPublish = await world.publish(mixed);
  const mixedJson = record(mixedPublish.json, "mixed publish output");
  const mixedBotSummaries = world.comments().filter((comment) =>
    comment.user.login === "github-actions[bot]" && comment.body.includes("openwork:warden-review-summary"),
  );
  expect(mixedPublish.code).toBe(0);
  expect(world.writes()).toHaveLength(writesAfterFirst + 1);
  expect(world.writes().at(-1)).toMatchObject({
    method: "PATCH",
    path: `/repos/openworklabs/openwork/issues/comments/${firstBotSummaries[0]?.id}`,
    authorization: "Bearer test-token",
  });
  expect(mixedBotSummaries).toHaveLength(1);
  expect(mixedBotSummaries[0]?.body).toContain("Native findings: **3**");
  expect(mixedBotSummaries[0]?.body).toContain("Blocking policy matches before consolidation: **3**");
  expect(mixedBotSummaries[0]?.body).toContain("<code>SEC-LOW</code> · low");
  expect(mixedBotSummaries[0]?.body).toContain("<code>CONF-MED</code> · medium");
  expect(mixedBotSummaries[0]?.body).toContain("<code>SYNC-HIGH</code> · high");
  expect(mixedBotSummaries[0]?.body).not.toContain(world.privateMarker);
  expect(world.comments().find((comment) => comment.id === 100)?.body).toContain("spoofed summary must remain human-owned");
  expect(mixedJson.metrics).toMatchObject({
    uniqueObservedRunAttempts: 2,
    distinctHeads: 1,
    observedTransitions: { resolved: 0, unresolved: 0 },
    firstObserved: { resolved: 1, unresolved: 1 },
    precision: null,
  });
  expect(world.reviewMutations()).toEqual([]);
  expect(mixedJson.status).toBe("published");
  expect(mixedJson.verdict).toBe("blocked");

  const writesAfterSecondAttempt = world.writes().length;
  const oldAttempt = await world.publish(advisory);
  expect(oldAttempt.code).not.toBe(0);
  expect(oldAttempt.stderr).toContain("producer run identity does not match receipt");
  expect(world.writes()).toHaveLength(writesAfterSecondAttempt);
  expect(world.comments().filter((comment) => comment.user.login === "github-actions[bot]")).toHaveLength(1);
  expect(world.reviewMutations()).toEqual([]);
  evidence.recordAssertionEvidence(
    "Run attempts update one trusted summary without replay overwrite",
    "Repeating the same receipt returned the retained metrics without a write or another thread read. A newer attempt patched only the page-two bot summary, retained one distinct head across two attempts, preserved blocker policy despite low confidence, and an older producer attempt could not overwrite it.",
    true,
  );

  const transitioned = await world.prepare("advisory", {
    headSha: world.heads.second,
    runId: "123457",
    attempt: 1,
  });
  expect(transitioned.result.code).toBe(0);
  world.setPullHead(world.heads.second);
  world.seedRun(transitioned, 8);
  world.resolveToggleThread();
  const transitionPublish = await world.publish(transitioned);
  const transitionJson = record(transitionPublish.json, "transition publish output");
  expect(transitionPublish.code).toBe(0);
  expect(transitionJson.metrics).toMatchObject({
    uniqueObservedRunAttempts: 3,
    distinctHeads: 2,
    currentUnresolvedThreads: 0,
    currentObservedThreads: 2,
    observedTransitions: { resolved: 1, unresolved: 0 },
    firstObserved: { resolved: 1, unresolved: 1 },
    precision: null,
    collectionWindow: { retainedRunAttempts: 3, limit: 20, truncated: false },
  });
  expect(transitionPublish.stdout).not.toContain("resolvedAt");
  expect(world.comments().at(-1)?.body).not.toContain("resolvedAt");
  expect(world.reviewMutations()).toEqual([]);
  expect(transitionJson.status).toBe("published");
  expect(transitionJson.verdict).toBe("clear");
  evidence.recordAssertionEvidence(
    "Thread metrics distinguish first observation from a later transition",
    "A Warden thread first seen resolved increased firstObserved.resolved without inventing a transition. A later unresolved-to-resolved snapshot increased only the resolved transition count; a clearance-like human thread was excluded, precision stayed null, and no exact resolution time or mutation was reported.",
    true,
  );

  const paginated = await world.prepare("advisory", {
    headSha: world.heads.second,
    runId: "123458",
  });
  expect(paginated.result.code).toBe(0);
  world.seedRun(paginated, 9);
  const paginatedThreadCounts = world.seedPaginatedThreads();
  const paginatedRequestStart = world.requests().length;
  const paginatedPublish = await world.publish(paginated);
  const paginatedJson = record(paginatedPublish.json, "paginated publish output");
  const paginatedGraphql = world.requests().slice(paginatedRequestStart)
    .filter((request) => request.path === "/graphql");
  expect(paginatedPublish.code).toBe(0);
  expect(paginatedThreadCounts).toEqual({ warden: 101, total: 102 });
  expect(paginatedGraphql).toHaveLength(2);
  expect(paginatedGraphql[0]?.body).toContain('"after":null');
  expect(paginatedGraphql[1]?.body).toContain('"after":"warden-thread-cursor-100"');
  expect(paginatedJson.metrics).toMatchObject({
    uniqueObservedRunAttempts: 4,
    distinctHeads: 2,
    currentUnresolvedThreads: 99,
    currentObservedThreads: 101,
    observedTransitions: { resolved: 1, unresolved: 0 },
    firstObserved: { resolved: 1, unresolved: 100 },
    precision: null,
    collectionWindow: { retainedRunAttempts: 4, limit: 20, truncated: false },
    threadSnapshot: { retained: 101, observed: 101, limit: 500, truncated: false },
  });
  expect(world.comments().filter((comment) => comment.user.login === "github-actions[bot]")).toHaveLength(1);
  expect(world.reviewMutations()).toEqual([]);
  expect(paginatedJson.status).toBe("published");
  expect(paginatedJson.verdict).toBe("clear");
  evidence.recordAssertionEvidence(
    "GraphQL thread collection crosses a real cursor page without trusting a human lookalike",
    "Two reviewThreads requests collected 101 Warden-authored threads across the 100-node cursor boundary. A marker from the same github-actions login with GraphQL typename User remained outside the metrics, while the REST summary retained github-actions[bot] ownership.",
    true,
  );

  const stale = await world.prepare("advisory", {
    headSha: world.heads.second,
    runId: "123459",
  });
  expect(stale.result.code).toBe(0);
  world.setPullHead(world.heads.second);
  world.seedRun(stale, 10);
  world.changeHeadAfterGraphql(world.heads.stale);
  const staleWriteCount = world.writes().length;
  const staleRequestStart = world.requests().length;
  const stalePublish = await world.publish(stale);
  const staleJson = record(stalePublish.json, "stale publish output");
  const staleRequests = world.requests().slice(staleRequestStart);
  expect(stalePublish.code).toBe(0);
  expect(staleRequests.filter((request) => request.path === "/repos/openworklabs/openwork/pulls/42")).toHaveLength(2);
  expect(world.writes()).toHaveLength(staleWriteCount);
  expect(world.reviewMutations()).toEqual([]);
  expect(staleJson.status).toBe("stale");
  expect(staleJson.verdict).toBe("clear");

  world.setPullHead(world.heads.second);
  const graphqlFailure = await world.prepare("advisory", {
    headSha: world.heads.second,
    runId: "123460",
  });
  expect(graphqlFailure.result.code).toBe(0);
  world.seedRun(graphqlFailure, 11);
  world.setGraphqlErrors(true);
  const graphqlWriteCount = world.writes().length;
  const failedGraphqlPublish = await world.publish(graphqlFailure);
  expect(failedGraphqlPublish.code).not.toBe(0);
  expect(failedGraphqlPublish.stderr).toContain("GitHub GraphQL returned errors");
  expect(world.writes()).toHaveLength(graphqlWriteCount);
  expect(world.reviewMutations()).toEqual([]);
  world.setGraphqlErrors(false);

  const mismatchedRun = await world.prepare("advisory", {
    headSha: world.heads.second,
    runId: "123461",
  });
  expect(mismatchedRun.result.code).toBe(0);
  world.seedRun(mismatchedRun, 12, { repository: "fixture/wrong-run-repository" });
  const mismatchedRunWriteCount = world.writes().length;
  const mismatchedRunPublish = await world.publish(mismatchedRun);
  expect(mismatchedRunPublish.code).not.toBe(0);
  expect(mismatchedRunPublish.stderr).toContain("producer run repository does not match receipt");
  expect(world.writes()).toHaveLength(mismatchedRunWriteCount);
  expect(world.reviewMutations()).toEqual([]);

  const repositoryMismatchRequestCount = world.requests().length;
  const repositoryMismatch = await world.prepare("repository-mismatch");
  expect(repositoryMismatch.result.code).not.toBe(0);
  expect(repositoryMismatch.result.stderr).toContain("findings repository does not match trusted metadata");
  expect(repositoryMismatch.result.stdout + repositoryMismatch.result.stderr).not.toContain(world.privateMarker);
  expect(world.requests()).toHaveLength(repositoryMismatchRequestCount);
  expect(world.writes()).toHaveLength(mismatchedRunWriteCount);

  const boundProducer = await world.prepare("advisory", {
    headSha: world.heads.second,
    runId: "123462",
  });
  expect(boundProducer.result.code).toBe(0);
  const forgedReceipt = await world.forgeReceiptProducer(boundProducer, {
    headSha: world.heads.forged,
    runId: "999999",
  });
  expect(forgedReceipt.receipt).toMatchObject({
    head_sha: world.heads.forged,
    producer: { headSha: world.heads.forged, runId: "999999" },
  });
  const forgedRequestCount = world.requests().length;
  const forgedWriteCount = world.writes().length;
  const deniedForgedReceipt = await world.publish(forgedReceipt);
  expect(deniedForgedReceipt.code).not.toBe(0);
  expect(deniedForgedReceipt.stderr).toContain("receipt producer does not match trusted workflow metadata");
  expect(world.requests()).toHaveLength(forgedRequestCount);
  expect(world.writes()).toHaveLength(forgedWriteCount);

  const authFailure = await world.prepare("advisory", {
    headSha: world.heads.second,
    runId: "123463",
  });
  expect(authFailure.result.code).toBe(0);
  world.seedRun(authFailure, 13);
  const authWriteCount = world.writes().length;
  const deniedToken = await world.publish(authFailure, "wrong-token");
  expect(deniedToken.code).not.toBe(0);
  expect(deniedToken.stderr).toContain("returned 401");
  expect(world.writes()).toHaveLength(authWriteCount);
  expect(world.requests().at(-1)).toMatchObject({
    method: "GET",
    path: "/repos/openworklabs/openwork/pulls/42",
    authorization: "Bearer wrong-token",
  });

  const wrongRepository = await world.prepare("wrong-repository", { runId: "123464" });
  expect(wrongRepository.result.code).toBe(0);
  const wrongRepositoryWriteCount = world.writes().length;
  const deniedRepository = await world.publish(wrongRepository);
  expect(deniedRepository.code).not.toBe(0);
  expect(deniedRepository.stderr).toContain("returned 404");
  expect(world.writes()).toHaveLength(wrongRepositoryWriteCount);
  expect(world.requests().at(-1)).toMatchObject({
    method: "GET",
    path: "/repos/fixture/not-openwork/pulls/42",
    authorization: "Bearer test-token",
  });
  expect(world.writes().every((request) => request.authorization === "Bearer test-token")).toBe(true);
  expect(world.reviewMutations()).toEqual([]);
  evidence.recordAssertionEvidence(
    "Stale heads, untrusted identity, and provider errors fail closed before writes",
    "The witness changed the head after GraphQL and the CLI re-read the PR before declining the stale write. GraphQL errors, mismatched run provenance, raw/metadata repository mismatch, a forged receipt that disagreed with trusted caller metadata, a wrong token, and a repository outside the fixture all produced no GitHub write; every accepted write used the scoped test token.",
    true,
  );

  const missingTrigger = await world.prepare("missing-trigger", { runId: "123465" });
  expect(missingTrigger.result.code).toBe(0);
  expect(missingTrigger.receipt).toMatchObject({ review_complete: false });
  expect(missingTrigger.receipt?.needs_recheck).toEqual(expect.arrayContaining([
    "missing-mandatory-trigger:confidentiality-review",
    "trigger-report-mismatch:confidentiality-review",
  ]));
  expect(JSON.stringify(missingTrigger.receipt)).not.toContain(world.privateMarker);
  expect(missingTrigger.receipt?.verdict).toBe("incomplete");

  const partial = await world.prepare("partial", { runId: "123466" });
  expect(partial.result.code).toBe(0);
  expect(partial.receipt).toMatchObject({ review_complete: false });
  expect(partial.receipt?.needs_recheck).toEqual(expect.arrayContaining([
    "partial-failed-hunks:diff-security-review",
    "partial-failed-extractions:confidentiality-review",
    "skill-error:diff-security-review",
  ]));
  expect(partial.result.stdout + partial.result.stderr + JSON.stringify(partial.receipt)).not.toContain(world.privateMarker);
  expect(partial.receipt?.verdict).toBe("incomplete");

  const malformed = await world.prepare("malformed", { runId: "123467" });
  expect(malformed.result.code).not.toBe(0);
  expect(malformed.receipt).toBeNull();
  expect(malformed.result.stdout + malformed.result.stderr).not.toContain(world.privateMarker);
  expect(world.reviewMutations()).toEqual([]);
  evidence.recordAssertionEvidence(
    "Incomplete and malformed analyzer output cannot become false clearance",
    "The production prepare command marked a missing mandatory trigger and partial hunk/extraction coverage incomplete while redacting model and error text. Structurally malformed native output exited nonzero and produced no receipt.",
    true,
  );

  const consolidated = await world.prepare("consolidated", {
    headSha: world.heads.second,
    runId: "123468",
  });
  expect(consolidated.result.code).toBe(0);
  expect(consolidated.receipt).toMatchObject({
    findings_count: 2,
    high_count: 0,
    blocking_count: 1,
    security_count: 1,
    sync_blocking_count: 0,
    sync_advisory_count: 0,
    review_complete: true,
    needs_recheck: [],
    coverage: {
      skills: [
        { name: "diff-security-review", status: "reported" },
        { name: "confidentiality-review", status: "reported" },
        { name: "spec-provenance-review", status: "reported" },
      ],
    },
    findings: [{
      id: "SHARED-NATIVE-ID",
      severity: "medium",
      skills: ["diff-security-review", "spec-provenance-review"],
      disposition: "blocker",
    }],
  });
  expect(consolidated.receipt?.findings).toHaveLength(1);
  expect(consolidated.receipt?.verdict).toBe("blocked");

  world.setPullHead(world.heads.second);
  world.seedRun(consolidated, 14);
  const humanCommentsBefore = world.comments().filter((comment) => comment.user.type === "User");
  const consolidatedWriteCount = world.writes().length;
  const consolidatedPublish = await world.publish(consolidated);
  const consolidatedJson = record(consolidatedPublish.json, "consolidated publish output");
  const consolidatedSummaries = world.comments().filter((comment) =>
    comment.user.login === "github-actions[bot]" && comment.body.includes("openwork:warden-review-summary"),
  );
  expect(consolidatedPublish.code).toBe(0);
  expect(consolidatedSummaries).toHaveLength(1);
  const consolidatedBody = consolidatedSummaries[0]?.body;
  if (!consolidatedBody) throw new Error("Missing consolidated Warden summary.");
  const blockersStart = consolidatedBody.indexOf("### Blockers\n");
  const advisoriesStart = consolidatedBody.indexOf("\n\n### Advisories");
  const needsRecheckStart = consolidatedBody.indexOf("\n\n### Needs recheck");
  expect(blockersStart).toBeGreaterThanOrEqual(0);
  expect(advisoriesStart).toBeGreaterThan(blockersStart);
  expect(needsRecheckStart).toBeGreaterThan(advisoriesStart);
  const blockerSection = consolidatedBody.slice(blockersStart, advisoriesStart);
  const advisorySection = consolidatedBody.slice(advisoriesStart, needsRecheckStart);
  expect(consolidatedBody).toContain("Native findings: **2**");
  expect(consolidatedBody.match(/<code>SHARED-NATIVE-ID<\/code>/g)).toHaveLength(1);
  expect(blockerSection).toContain("<code>SHARED-NATIVE-ID</code> · medium · diff-security-review, spec-provenance-review");
  expect(advisorySection).not.toContain("SHARED-NATIVE-ID");
  expect(consolidatedJson.metrics).toMatchObject({ currentObservedThreads: 101 });
  expect(world.comments().filter((comment) => comment.user.type === "User")).toEqual(humanCommentsBefore);
  expect(world.writes()).toHaveLength(consolidatedWriteCount + 1);
  expect(world.writes().at(-1)).toMatchObject({
    method: "PATCH",
    path: `/repos/openworklabs/openwork/issues/comments/${consolidatedSummaries[0]?.id}`,
    authorization: "Bearer test-token",
  });
  expect(world.reviewMutations()).toEqual([]);
  expect(consolidatedJson.status).toBe("published");
  expect(consolidatedJson.verdict).toBe("blocked");
  evidence.recordAssertionEvidence(
    "One native ID shared by security and provenance remains one blocking report entry",
    "Two identical native records retained raw count 2 while consolidating to one rendered ID with both skill attributions. Security policy won over provenance advisory policy: the ID appeared once under Blockers and never under Advisories, while generic human comments and all review/thread mutation surfaces remained untouched.",
    true,
  );

  evidence.recordAssertionEvidence(
    "Proof scope is the reporter HTTP contract and classification lifecycle",
    "This hermetic journey executes the production Warden CLI against a deterministic GitHub HTTP witness. It does not claim native upstream model precision, real GitHub merge-button behavior, or any provider write.",
    true,
  );
});
