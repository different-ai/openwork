# Warden review reporting

OpenWork uses Warden's existing GitHub Actions identity and native checks. The
reporting helper adds one consolidated ordinary pull-request comment and one
sanitized analysis receipt plus one bounded publish-measurement artifact; it
does not add a bot, service, cache, approval
source, review-thread mutation, or immutable event ledger.

## Data flow and authority

1. `.github/workflows/warden.yml` runs pinned Warden `0.43.0` analyze mode.
2. Before Warden report mode overwrites the analyze output, the workflow fetches
   `warden-review.mjs` from the immutable pull-request base SHA through GitHub's
   authenticated Contents API. It validates the SHA syntax, requires regular
   file metadata, verifies the downloaded bytes against GitHub's blob SHA, and
   runs only that read-only `RUNNER_TEMP` copy. Checkout credentials are not
   persisted, and the fetch and `prepare` steps do not receive the model API
   key. The pull request's checked-out helper is never executed.
3. `prepare` validates the analyzer document against trusted workflow metadata
   and writes `warden-summary.json` only after removing any checked-out file at
   that path. A non-empty replay roster is required, both mandatory security
   triggers must have successful reports, and replay reports must reconcile
   one-for-one with the native top-level reports. Multiple successful triggers
   may report the same skill; receipt coverage names remain unique.
   Partial-analysis fields are read from this pre-report output. Missing or
   contradictory reports are unknown/incomplete, never inferred as zero.
4. `warden-clearance.yml` checks out the immutable `github.workflow_sha`,
   downloads the receipt into a dedicated `RUNNER_TEMP` directory outside the
   trusted checkout, rejects anything except one regular, non-symlink
   `warden-summary.json`, binds it to the outer workflow-run repository, ID,
   attempt, and head, and then calls the helper by its trusted checkout path.
   Publication validates the open, unmerged current PR head/base and completed
   producer run before writing one ordinary `github-actions[bot]` issue comment,
   and repeats the PR check immediately before that write.
5. The receipt and comment are display data, not approval authority. The
   clearance workflow separately preserves the same-repository, current-head,
   and review-machinery guards. The GitHub App can approve only when
   `review_complete` is true, `verdict` is `clear`, and the recomputed blocking
   count is zero. Missing receipts, partial analysis, publication failure, and
   unknown data cannot grant clearance. Review-machinery file enumeration must
   complete before path matching; an API failure stops approval. A blocked or
   incomplete run dismisses every still-active approval authored by the
   dedicated App Bot, never a human review, and dismissal failure is fatal.

Security and confidentiality findings block at every severity and confidence.
Desktop↔Den sync findings block unless their severity is `medium` or `low`.
Provenance findings are advisory. Optional path-scoped skills are reported only
when Warden emitted them; their absence is not presented as completed coverage.

## Trusted-helper bootstrap

The first pull request that introduces the helper can have a base SHA where the
known path does not exist. Only an exact GitHub API `404` is treated as this
bootstrap case: native Warden report mode still runs, but `prepare` is skipped
and no `warden-summary` artifact is uploaded. The existing clearance consumer
may therefore fail because its expected artifact is absent; that is an honest
incomplete result and requires independent review, not a fallback to pull-
request-controlled code. Every non-404 fetch failure, malformed response, or
blob-integrity mismatch fails closed.

After the helper lands on the protected base branch, rerun or synchronize a
subsequent pull request against that base. Hosted proof still must show that the
trusted-base helper produced the receipt and that the normal clearance flow
consumed it; the bootstrap run alone cannot provide that deployment proof.

## Sanitized receipt

The artifact preserves the legacy `head_sha`, `findings_count`, `high_count`,
`blocking_count`, `security_count`, `sync_blocking_count`, and
`sync_advisory_count` fields. It adds bound producer metadata,
`review_complete`, `verdict`, reported-trigger coverage, safe finding IDs and
attribution, and machine-safe recheck reason codes. PR titles, authors, branch
names, finding titles/descriptions/hunks, model summaries, and error messages
are excluded. Confidentiality locations are always omitted. IDs are copied from
the current native report; advisory ID stability across runs is not promised.

Example non-empty shape:

```json
{
  "schema_version": "1",
  "producer": {
    "repository": "openworklabs/openwork",
    "pr": 42,
    "headSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "baseSha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "runId": "123456",
    "attempt": 1
  },
  "analysisAt": "2026-09-09T12:00:00.000Z",
  "head_sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "findings_count": 2,
  "high_count": 1,
  "blocking_count": 1,
  "security_count": 1,
  "sync_blocking_count": 0,
  "sync_advisory_count": 1,
  "review_complete": true,
  "verdict": "blocked",
  "coverage": {
    "label": "reported-trigger-coverage",
    "skills": [
      { "name": "diff-security-review", "status": "reported", "durationMs": 1200 },
      { "name": "confidentiality-review", "status": "reported", "durationMs": 900 },
      { "name": "desktop-den-sync-review", "status": "reported", "durationMs": 800 }
    ]
  },
  "findings": [
    { "id": "SEC-1", "severity": "high", "skills": ["diff-security-review"], "disposition": "blocker" },
    { "id": "SYNC-1", "severity": "medium", "skills": ["desktop-den-sync-review"], "disposition": "advisory" }
  ],
  "needs_recheck": []
}
```

The analyzer contract is pinned to these Warden sources:

- [`output.ts`](https://github.com/getsentry/warden/blob/8759014a14130cd2b82e59d3fb450a7385721221/packages/warden/src/action/reporting/output.ts)
- [`types/index.ts`](https://github.com/getsentry/warden/blob/8759014a14130cd2b82e59d3fb450a7385721221/packages/warden/src/types/index.ts)
- [`outcomes.ts`](https://github.com/getsentry/warden/blob/8759014a14130cd2b82e59d3fb450a7385721221/packages/warden/src/action/reporting/outcomes.ts)
- [`pr-workflow.ts`](https://github.com/getsentry/warden/blob/8759014a14130cd2b82e59d3fb450a7385721221/packages/warden/src/action/workflow/pr-workflow.ts)
- [`dedup.ts`](https://github.com/getsentry/warden/blob/8759014a14130cd2b82e59d3fb450a7385721221/packages/warden/src/output/dedup.ts)

## Publish reads and write

`publish` uses `GITHUB_TOKEN`, `GITHUB_API_URL` (default
`https://api.github.com`), and `GITHUB_GRAPHQL_URL` (default
`https://api.github.com/graphql`). The trusted parent additionally sets the
all-or-none `WARDEN_EXPECTED_REPOSITORY`, `WARDEN_EXPECTED_RUN_ID`,
`WARDEN_EXPECTED_RUN_ATTEMPT`, and `WARDEN_EXPECTED_HEAD_SHA` binding. The
standalone `publish --receipt` interface remains valid without those optional
values and still requires the same GitHub API identity checks. Its REST
endpoints are:

- `GET /repos/{owner}/{repo}/pulls/{pr}`
- `GET /repos/{owner}/{repo}/actions/runs/{runId}`
- paginated `GET /repos/{owner}/{repo}/issues/{pr}/comments`
- one `POST /repos/{owner}/{repo}/issues/{pr}/comments` or
  `PATCH /repos/{owner}/{repo}/issues/comments/{commentId}`

GraphQL reads every `reviewThreads` page and only each thread's initial comment.
A thread is attributed to Warden only when that initial comment has the exact
`<!-- warden:finding:v1:` marker prefix and its actual author is the
`github-actions` GraphQL Bot. GitHub's REST issue-comment identity remains
`github-actions[bot]`; the two API identity spellings are deliberately not
interchangeable.
Bodies are never retained in receipt, metrics, or hidden comment state.
Existing review threads are not migrated, resolved, dismissed, or otherwise
mutated by the publisher.

Every GitHub request has a 15-second timeout. GraphQL pagination requires a
well-formed `pageInfo` and a non-empty advancing cursor while another page is
advertised. Duplicate thread IDs count once. A producer run with associations
must carry a repository-qualified association for the receipt PR, head, and
base. Because GitHub can return an empty association list for historical runs,
that case is accepted only when the run repository/head and its head branch all
match the directly fetched, same-repository PR. There is no arbitrary commit-to-
first-PR fallback.

## Metric limits

Metrics describe a bounded sequence of collection snapshots stored in the one
trusted summary comment. The current implementation retains at most 20 unique
observed run attempts and at most 500 attributed thread states for transition
comparison, and says when either window has truncated. It reports
distinct heads in that window, current unresolved attributed threads, and
resolved/unresolved state changes observed between snapshots. A thread already
resolved at its first collection is labelled **first observed resolved**, not a
resolution event or time. A missing receipt or cancelled analysis produces no
replacement observation; its findings and thread metrics are unknown, never
recorded as zero. The clearance workflow runs only for successful Warden runs,
so failed or cancelled producer runs (and successful runs with missing
artifacts or failed publication) have no publish-measurement artifact rather
than a zero-valued row.
REST or GraphQL failures stop publication and therefore cannot publish a false
clear or empty observation count.

Precision is `null`/unavailable because no human adjudication labels establish
true or false positives. The metrics are not lifetime totals, exact event
times, evidence of who resolved a thread, proof of full analysis context, or an
immutable ledger.

The sanitized `warden-summary` analysis receipt and separate
`warden-publish-result-{runId}-{attempt}` publication result use GitHub artifact
storage with an explicit 90-day retention period. The publication artifact
contains only bound producer identity, publication status/verdict/comment ID,
and the same bounded metrics rendered in the mutable comment. It is retained
measurement evidence, not an infinite or immutable all-runs ledger and not
clearance authority.
