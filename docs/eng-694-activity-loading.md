# ENG-694 — Dashboard Activity loading

## Scope and status

The issue and comments were read through Linear on 2026-10-07. They report several seconds of Activity placeholders but contain no request trace or production timing measurements. This investigation uses synthetic workspace names and disposable test organizations; it does not change production data or feature rollouts.

Baseline source: `02a3eec76ccb501d2dd83d300036f3b7daa639d4`.
Verified implementation: `1b0f6cebe950b25bb10465e6475801d54d9310dc` on `fix/eng-694-activity-loading`, pushed only to enable immutable-ref Daytona verification. No PR, merge, force push, or production rollout change.

Focused verdict: **Passed** — 17 unit tests and both browser journeys (functional journey passed on its one retry). Full-repository verification is **Incomplete** because evals typecheck has two clean-control-reproduced baseline errors; the initial browser sign-in failure also remains unexplained. This final report is documentation-only; product and test sources are unchanged from the verified implementation.

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

## Changed files

- `ee/apps/den-web/app/(den)/dashboard/_features/activity/activity-data.ts` — the only product change: conservative history candidate selection.
- `ee/apps/den-web/app/(den)/dashboard/_features/activity/activity-data.test.ts` — correctness, ties, exhaustive equivalence and outage regressions.
- `ee/apps/den-web/app/(den)/dashboard/_features/activity/activity-loading.test.ts` — deterministic cold/warm request-wave loop.
- `evals/specs/den-dashboard-activity-loading.e2e.test.ts` — real-browser performance and continuity proof.
- `evals/worlds/den-dashboard-activity.ts` — optional real persisted scale fixture and sequential same-owner org cleanup.
- `evals/worlds/den-dashboard-activity-timing.ts` — read-only DOM/resource/server timing observations.
- `docs/eng-694-activity-loading.md` — commands, measurements, evidence and limitations.

## Coverage and commands

```sh
pnpm --filter @openwork-ee/den-api exec tsx --test '../den-web/app/(den)/dashboard/_features/activity/activity-data.test.ts'
pnpm --filter @openwork-ee/den-api exec tsx --test '../den-web/app/(den)/dashboard/_features/activity/activity-loading.test.ts'
pnpm --filter @openwork-ee/den-web typecheck
pnpm evals:typecheck
OPENWORK_EVAL_REF=02a3eec76ccb501d2dd83d300036f3b7daa639d4 pnpm evals:e2e den-dashboard-activity-loading --strict-ref
OPENWORK_EVAL_REF=1b0f6cebe950b25bb10465e6475801d54d9310dc pnpm evals:e2e den-dashboard-activity-loading --strict-ref
OPENWORK_EVAL_REF=1b0f6cebe950b25bb10465e6475801d54d9310dc pnpm evals:e2e den-dashboard-activity --strict-ref
```

The unit coverage includes timestamp ties, unknown bounds, deleted latest versions, duplicate discovery, multiple versions from one skill, candidate-read outage retention, pagination, cancellation, bounded concurrency, and comparison with exhaustive fetching across twenty dated workspaces.

The browser performance journey seeds twelve real plugins with eight skills each through Den, measures cold placeholders and browser request timings, compares a warm return, and captures screenshots. It asserts that cold loading does not scan all 96 histories. Timestamp ties are allowed rather than silently discarded.

### Check classification

- Original functional E2E on baseline: **1 passed, 0 failed, 0 skipped** (376.24 seconds). Placement: `daytona (daytona CLI authenticated) ref=dev@02a3eec76`. It covers outage/retry, truthful stored timestamps, organization switching, rollout-off Quick add, and unchanged member home. This is baseline evidence, not a verdict on the fix.
- Loader correctness: **16 passed, 0 failed, 0 skipped**, exit 0. Deterministic loading loop: **1 passed, 0 failed, 0 skipped**, exit 0.
- Populated browser journey on fix `1b0f6cebe950b25bb10465e6475801d54d9310dc`: **1 passed, 0 failed, 0 skipped**, exit 0 (266.79 seconds). Placement: `daytona (daytona CLI authenticated) ref=1b0f6cebe950b25bb10465e6475801d54d9310dc`. A new Den/browser stack was provisioned; no warm-server reuse override.
- The first post-fix functional run exited 1 (0 passed, 1 failed, 0 skipped; 300.87 seconds) before Activity: the owner browser remained on the `/` sign-in page, the workspace-switcher wait timed out, and the Activity request witness was empty. Record: `evals/results/test-runs/2026-10-07T17-32-33-723Z-84341-an-owner-sees-real-workspace-additions-keeps-them-during-an-outage-and-does-not-/test-run.json`. This is an unresolved launch/auth-arrangement failure, not a demonstrated Activity regression or a claim of a pre-existing failure. The one same-commit, cold-boot retry **passed: 1 passed, 0 failed, 0 skipped**, exit 0 (341.57 seconds), with no auth/product changes. It proved outage/retry retention, truthful timestamps, organization isolation, rollout-off Quick add and unchanged member home. Record: `evals/results/test-runs/2026-10-07T17-38-27-076Z-85448-an-owner-sees-real-workspace-additions-keeps-them-during-an-outage-and-does-not-/test-run.json`. The earlier sign-in failure remains unresolved, not reclassified as a clean pass.
- Den Web typecheck and scoped ESLint on the three Activity source/test files: passed, exit 0.
- Evals typecheck: two unrelated errors in `evals/specs/route-session-list.test.ts:108,111` (`workspaceType` is not in `Pick<WorkspaceWire, "id">`). A clean `git archive` snapshot of the baseline inside this worktree reproduces both with the identical underlying command, `node evals/scripts/typecheck.mjs` (exit 1, two errors). The changed tree returns the same two errors. No unrelated source was changed. The first control invocation through pnpm was blocked by its symlinked-install check; direct invocation runs the exact typecheck script with the same installed toolchain.

## Browser evidence

A retained real-browser baseline (Daytona, source `02a3eec76`) measured **2,965 ms from skeleton insertion to first row insertion**, and 3,474 ms from navigation origin to rows. It made **97 history GETs**, corroborated by 97 successful server requests. The history phase ran from 1,277 to 3,464 ms; rows arrived 10 ms after its last response. Server handling for history reads was 4.66–33.11 ms; browser round trips were mostly about 100 ms. This supports request-wave overhead, rather than rendering or one slow server read, as the dominant delay in this fixture.

Record: `evals/results/test-runs/2026-10-07T17-16-03-118Z-80445-an-owner-opens-a-populated-workspace-without-reading-every-skill-s-history/test-run.json`. This intentionally red baseline exited 1 (0 passed, 1 failed, 0 skipped) on the history-read bound; teardown succeeded.

Earlier attempts are not hidden: the first populated baseline reached the bound assertion but its parallel organization cleanup returned HTTP 500, losing the ambient report. The fixture now disposes those same-owner orgs sequentially; the next completed run cleaned up successfully. An intervening retry failed before the journey at Daytona provisioning HTTP 502 (0 passed, 1 failed, 0 skipped); no product verdict was inferred, no execution-lane switch was made, and the sandbox was already absent on explicit cleanup.

The passing fix run verifies reload via a changed `performance.timeOrigin`, corroborates successful history counts with server access logs, checks rows against independently persisted version metadata, and observes a real warm leave/return interval.

| Real browser measurement | Baseline `02a3eec76` | Fix `1b0f6cebe` |
| --- | ---: | ---: |
| Skeleton insertion → first row DOM insertion | 2,965 ms | 752 ms |
| Navigation origin → rows | 3,474 ms | 1,257 ms |
| History reads (browser and successful server GETs) | 97 | 5 |
| History phase span | 2,187 ms | 102 ms |
| Median history request in browser | 102 ms | 88 ms |
| Median history handling in Den | 8.14 ms | 19.11 ms |
| Last history response → rows | 10 ms | 12 ms |

These are individual observations in equivalent disposable datasets, not an SLA or production benchmark. Both workloads include 96 added skills plus the world's pre-existing briefing skill. The improvement remains when transport timing is held constant in the deterministic loop. The server median was actually higher in the fix sample: the improvement is fewer serial request waves, not a faster DB or hidden skeleton.

The warm leave/return on the fix kept the same stored rows visible with **zero Activity loading transitions** during a 4,977 ms observation window, which includes driver/assertion overhead. Its observed Activity content requests spanned 637 ms (13,472–14,109 ms in the document timeline). The browser test proves continuity through the content reread, not network idle; the loader test separately proves complete warm refresh/version-cache behavior.

After record: `evals/results/test-runs/2026-10-07T17-27-56-439Z-83108-an-owner-opens-a-populated-workspace-without-reading-every-skill-s-history/test-run.json`.

Screenshots (1440 × 900, reviewed at source size):

- Before: `evals/results/test-runs/2026-10-07T17-16-03-118Z-80445-an-owner-opens-a-populated-workspace-without-reading-every-skill-s-history/04-after-a-cold-reload-reads-only-histories-that-can-reach-the-newest-five.png`
- After: `evals/results/test-runs/2026-10-07T17-27-56-439Z-83108-an-owner-opens-a-populated-workspace-without-reading-every-skill-s-history/04-after-a-cold-reload-reads-only-histories-that-can-reach-the-newest-five.png`
- Warm: the same after directory's `06-a-warm-return-keeps-the-same-real-rows-visible-while-refreshing.png`.

Two additional verification errors were corrected, not classified as product bugs: an exact-text switcher assertion failed because the button also contains the admin role (changed to a substring regexp), and an abbreviated Git SHA could not be fetched in Daytona (rerun with the full immutable SHA). Each failed run reported 0 passed, 1 failed, 0 skipped. The passing run above includes both corrections.

These are cold **application-query** loads, not a cold browser/DB benchmark. No production latency claim is made.

## Design and remaining limits

No layout or loading-state changes: DESIGN.md P1, P10, P11 and States are preserved. Actual placeholders and previous successful rows remain truthful; nothing is hidden to make timing look faster.

Very large plugin inventories, many exactly tied timestamps, old servers without latest-version metadata, or slow provider/content reads can still be slow. The loader still enumerates authorized plugins and marketplaces. No production HAR, realistic production inventory count, or DB query profile was available, so the original report's exact production latency remains unconfirmed.
