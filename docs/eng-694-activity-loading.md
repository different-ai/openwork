# ENG-694 — Dashboard Activity loading

## Scope and status

The issue and comments were read through Linear on 2026-10-07. They report several seconds of Activity placeholders but contain no request trace or production timing measurements. This investigation uses synthetic workspace names and disposable test organizations; it does not change production data or feature rollouts.

Baseline source: `02a3eec76ccb501d2dd83d300036f3b7daa639d4`.

## Reproduction and diagnosis

The real `fetchDashboardActivity` loader is exercised by a deterministic virtual transport, with each request taking 150 ms. This measures dependency/request-wave time, **not production wall-clock latency**. It settles in milliseconds on the test runner and fails if populated cold loading takes at least two simulated seconds.

```sh
pnpm --filter @openwork-ee/den-api exec tsx --test '../den-web/app/(den)/dashboard/_features/activity/activity-loading.test.ts'
```

Before the fix, repeated invocations exited 1 with:

```text
Activity pending for 3600ms with 12 plugins / 96 skills
```

| Dataset | Cold before | Cold after | Requests before → after | Warm before / after |
| --- | ---: | ---: | ---: | ---: |
| 1 plugin, 1 skill | 450 ms | 450 ms | 6 → 6 | 300 ms / 300 ms |
| 12 plugins, 96 skills | 3,600 ms | 750 ms | 112 → 21 | 600 ms / 600 ms |
| 1 plugin, 56 skills | 2,100 ms | 450 ms | 61 → 10 | 300 ms / 300 ms |
| 1 plugin, 55 skills | 1,950 ms | 450 ms | 60 → 10 | 300 ms / 300 ms |

Cold and warm rows are identical. The 56/55-skill pair minimizes the two-second failure threshold with one plugin and no connections/providers/marketplaces. This isolates history fan-out from React rendering and slow individual endpoints.

The loader's dependency graph is:

1. Parallel connection/provider/plugin/marketplace discovery (gateway providers only when enabled).
2. Authorized resolved plugin contents, concurrency five.
3. Marketplace attachments, concurrency five.
4. Up to five history entries for **every** discovered skill, concurrency five.
5. Publish one complete snapshot and render its newest five rows.

Before the fix, a cold 96-skill workspace paid for 20 history request waves. The existing version cache removed those waves on warm loads, but not reloads. Nothing in the component intentionally delays rendering after the query resolves.

Ranked hypotheses were history fan-out, unnecessary phase sequencing, slow server reads, and rendering delay. The virtual loop establishes the first as a concrete bottleneck. It does not establish which accounts for the original production report. Server discovery/content costs and phase sequencing are deliberately not changed without measurements justifying a broader fix.

## Fix

`activity-data.ts` uses metadata already present in freshly authorized resolved contents. The server's `getLatestVersions` selects by `createdAt DESC, id DESC`; the history endpoint uses the same timestamp ordering. Five distinct known events establish a lower bound on the final fifth event. A skill whose newest stored version is strictly older cannot contribute, so its history read is unnecessary.

- Equal timestamps remain candidates, preserving final event-ID ordering.
- Missing/invalid dates or missing/mismatched skill identity fall back to reading history.
- Deleted latest versions cannot establish the cutoff.
- Known events are deduplicated before calculating the cutoff.
- Metadata only selects reads: displayed skill rows still come from the history endpoint.
- No new endpoint, schema migration, cache, event store, or timestamp inference.
- The existing authorization, identity/org-scoped cache keys, cancellation, pagination, and concurrency limit remain unchanged.
- A required candidate read failing still rejects the snapshot, retaining the previous complete TanStack Query data.
- `dashboardActivity` remains default-off; Quick add and member home are unchanged. This is a bug fix within the existing rollout, not another feature.

## Coverage and commands

```sh
pnpm --filter @openwork-ee/den-api exec tsx --test '../den-web/app/(den)/dashboard/_features/activity/activity-data.test.ts'
pnpm --filter @openwork-ee/den-api exec tsx --test '../den-web/app/(den)/dashboard/_features/activity/activity-loading.test.ts'
pnpm --filter @openwork-ee/den-web typecheck
pnpm evals:typecheck
OPENWORK_EVAL_REF=02a3eec76ccb501d2dd83d300036f3b7daa639d4 pnpm evals:e2e den-dashboard-activity-loading --strict-ref
pnpm evals:e2e den-dashboard-activity
```

The unit coverage includes timestamp ties, unknown bounds, deleted latest versions, duplicate discovery, multiple versions from one skill, candidate-read outage retention, pagination, cancellation, bounded concurrency, and comparison with exhaustive fetching across twenty dated workspaces.

The browser performance journey seeds twelve real plugins with eight skills each through Den, measures cold placeholders and browser request timings, compares a warm return, and captures screenshots. It asserts that cold loading does not scan all 96 histories. Timestamp ties are allowed rather than silently discarded.

### Check classification

- Original functional E2E on baseline: **1 passed, 0 failed, 0 skipped** (376.24 seconds). Placement: `daytona (daytona CLI authenticated) ref=dev@02a3eec76`. It covers outage/retry, truthful stored timestamps, organization switching, rollout-off Quick add, and unchanged member home. This is baseline evidence, not a verdict on the fix.
- Den Web typecheck: passed.
- Evals typecheck: two unrelated errors in `evals/specs/route-session-list.test.ts:108,111` (`workspaceType` is not in `Pick<WorkspaceWire, "id">`). A clean `git archive` snapshot of the baseline inside this worktree reproduces both with the identical underlying command, `node evals/scripts/typecheck.mjs` (exit 1, two errors). The changed tree returns the same two errors. No unrelated source was changed. The first control invocation through pnpm was blocked by its symlinked-install check; direct invocation runs the exact typecheck script with the same installed toolchain.

## Browser evidence

A retained real-browser baseline (Daytona, source `02a3eec76`) measured **2,965 ms from skeleton insertion to first row insertion**, and 3,474 ms from navigation origin to rows. It made **97 history GETs**, corroborated by 97 successful server requests. The history phase ran from 1,277 to 3,464 ms; rows arrived 10 ms after its last response. Server handling for history reads was 4.66–33.11 ms; browser round trips were mostly about 100 ms. This supports request-wave overhead, rather than rendering or one slow server read, as the dominant delay in this fixture.

Record: `evals/results/test-runs/2026-10-07T17-16-03-118Z-80445-an-owner-opens-a-populated-workspace-without-reading-every-skill-s-history/test-run.json`. This intentionally red baseline exited 1 (0 passed, 1 failed, 0 skipped) on the history-read bound; teardown succeeded.

Earlier attempts are not hidden: the first populated baseline reached the bound assertion but its parallel organization cleanup returned HTTP 500, losing the ambient report. The fixture now disposes those same-owner orgs sequentially; the next completed run cleaned up successfully. An intervening retry failed before the journey at Daytona provisioning HTTP 502 (0 passed, 1 failed, 0 skipped); no product verdict was inferred, no execution-lane switch was made, and the sandbox was already absent on explicit cleanup.

The final timing instrumentation additionally verifies reload via a changed `performance.timeOrigin`, corroborates successful history counts with server access logs, checks rows against independently persisted version metadata, and observes a real warm leave/return interval. The stronger baseline/fix comparison is pending. These are cold **application-query** loads, not a cold browser/DB benchmark. No production latency claim is made.

## Design and remaining limits

No layout or loading-state changes: DESIGN.md P1, P10, P11 and States are preserved. Actual placeholders and previous successful rows remain truthful; nothing is hidden to make timing look faster.

Very large plugin inventories, many exactly tied timestamps, old servers without latest-version metadata, or slow provider/content reads can still be slow. The loader still enumerates authorized plugins and marketplaces. No production HAR, realistic production inventory count, or DB query profile was available, so the original report's exact production latency remains unconfirmed.
