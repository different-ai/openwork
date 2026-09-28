# Testing

The one guide to OpenWork's tests and E2E proofs. Agents start at
[`evals/AGENTS.md`](../evals/AGENTS.md); spec mechanics live in
[`evals/README.md`](../evals/README.md).

- [What blocks a merge](#what-blocks-a-merge) · [Broader coverage](#broader-coverage)
- E2E proofs: [User flow vs agent flow](#user-flow-vs-agent-flow) ·
  [Add a journey](#add-a-journey) · [Journey tags](#journey-tags) ·
  [How CI picks journeys](#how-ci-picks-journeys) ·
  [Read the result](#read-the-result) · [Slack alerts](#slack-alerts)

## Before a PR

Run `pnpm test` (alias: `pnpm test:core`) before a PR. Install both workspaces
with `pnpm install --frozen-lockfile` and
`pnpm --dir evals install --frozen-lockfile` first. Use Node 24, Bun 1.3.14,
pnpm 11.4.0, and the OpenCode version in `constants.json` on PATH, matching CI.
The core suite uses local fixtures and scripted providers; no cloud account,
provider key, Docker daemon, or running Den database is required.

## What blocks a merge

The `openwork-tests-required` check keeps its existing name and fails closed.
For ordinary code changes it requires two independent Linux jobs:

- **Core regressions:** session admission, streaming and reconnects, permission
  state, attachments, provider credentials, and Connect reconciliation in the
  client; real server routes for threads, groups, proxying, folder permissions,
  upload approval, artifact I/O, cloud configuration, engine eviction and
  reloads; token scope and export safety; Den authentication; desktop workspace
  persistence, archives, links, credential keys, automation execution, process resilience, and TLS.
  Three existing real-engine journeys additionally check remembered thread
  approvals, effective permission attribution, and PDF model routing.
- **Packaging:** outbound-access declarations, the server's actual Node-target
  plugin build, and Electron's IPC contract typecheck. A test failure cannot
  prevent this independent job from reporting a packaging regression.

Model-snapshot-only and docs-only PRs keep their existing dedicated validation.
New commits cancel obsolete runs on the same PR. Dev pushes still run the core
and packaging checks. PRs no longer pay for two OS copies of the broad suites.

The package `test:core` scripts are the selection. There is no second inventory,
selection generator, coverage ratchet, or test asserting that inventory matches
itself. To expand coverage, extend an existing test for a core failure mode.
Add a test to the gate when it catches an observable regression in a critical
journey, runs deterministically with declared prerequisites, and earns its cost.
Do not add source-text/layout assertions, test-runner wrappers, or bookkeeping
checks to this gate. A failing core test must be diagnosed and fixed, not retried
until green or silently ignored.

## Broader coverage

The same OpenWork Tests workflow runs the broad app, server, Den, desktop,
release, test-framework, PR-spec, and engine-smoke suites on Linux and macOS at
07:37 UTC daily, or through **Run workflow** on a selected branch. Each suite
reports even if an earlier suite fails; failures still make that run red.
`pnpm test:extended` runs those test suites locally. Packaging can be reproduced
with `pnpm --filter openwork-server build` and
`pnpm --filter @openwork/desktop typecheck:electron`.

Use the full package test command when changing its internals, and
`pnpm test:eval-runner` when changing the test framework. These tests remain in
the repository. Moving them out of the universal gate means regressions outside
the selected core may first be detected by targeted validation or the nightly
run. Check the macOS nightly before releases; it is no longer a PR prerequisite.
The existing Daytona E2E and nightly flake-report workflows are unchanged.

A skipped journey is incomplete coverage, even if a runner exits successfully.
Do not describe a run containing skips as full proof.

## E2E proofs

Every `evals/specs/*.e2e.test.ts` a PR adds or changes runs on the PR head and
is published as that PR's proof: a review report and one PR comment. Skills
walk the path: `write-a-spec` → `run-tests` → `diagnose-a-red-run` →
`open-a-pr`.

### User flow vs agent flow

Tag every test with who acts in it; the report and PR comment group proofs
under **User flow**, **Agent flow** and **Unlabelled**.

- `user-flow`: a person goes through the real UI (app-web, desktop, Den web).
  Every step is a click or typed input that ends with a screenshot.
- `agent-flow`: an agent, MCP client or server acts; the proof is the requests
  and responses (`recordAssertionEvidence`).

**Rule:** if a person can see or click something that changed, the PR needs a
user-flow spec, and the PR's Evidence lists it first. Without one the comment
says "No user-flow proof"; the fix is to add `{ tags: ["user-flow"] }` to a
test that drives the UI. An untagged test shows as "Unlabelled".

```ts
test("a member shares a chat with a teammate", { tags: ["user-flow"] }, async ({ user, step }) => …);
test("an MCP client lists the shared chat", { tags: ["agent-flow"] }, async ({ agent, evidence }) => …);
```

### Add a journey

A journey is one spec file; there is no list to edit.

```bash
pnpm evals:new invite-teammate --flow user           # add --engine v2, --critical, --world
pnpm evals:e2e invite-teammate --local                # run it, read evals/results/test-runs/<latest>/
```

The scaffold writes the parts CI reads:

1. A JSDoc block at the very top: its first line is the journey's readable
   name; `@module-tag` lines tag the whole file (see [Journey tags](#journey-tags)).
2. `spec.world(world, { resources: { … } })`: new bindings must declare
   `resources` (channel ratchet).
3. Each test carries `user-flow` or `agent-flow`. A registered `--case` also
   carries `engine-v1`/`engine-v2` and its title starts with its case ID
   (`test("HOME-01 …", { tags: ["engine-v2"] }, …)`); IDs are unique.
4. The spec imports only `@openwork/testkit`, `vitest` and its world; no raw
   escapes (`seed.evalIn`, `probe.eval`, `client.send`, …) and no product
   source (layer check, boundary and channel ratchets).

Tests must be named `test`, `it`, `test…` or `…Test` so Vitest's static parser
finds them.

### Journey tags

Tags are declared once, with their descriptions, in `evals/vitest.config.ts`
(`strictTags` rejects anything else). List them with
`pnpm --dir evals exec vitest --list-tags`. Journey tags are file-level
`@module-tag`s; `packaged`, `macos` and `live-openai` must match what the spec
and its worlds guard (`node --test evals/scripts/journey-ci.test.mjs` checks
both directions).

<!-- tags:start -->
<!-- Generated from evals/vitest.config.ts by `pnpm --dir evals docs:tags`; edit the descriptions there. -->

| Tag | Meaning |
| --- | --- |
| `checkpoints` | Save the world's end state (and marked steps) as reopenable checkpoints when run with --checkpoints on a world that can capture. |
| `user-flow` | A person goes through the real UI; every step is a click or typed input that ends with a screenshot of what they see. |
| `agent-flow` | The actor is an agent, an MCP client or a server; the proof is the requests and responses. |
| `critical` | Journey (@module-tag): a critical user journey; required on every PR and every dev merge, whatever the change touched. |
| `local-only` | Journey (@module-tag): needs the local lane (loopback fixtures, the testkit database, fault proxies or host binaries); never scheduled on Daytona. |
| `live-model` | Journey (@module-tag): calls real paid models instead of the mock provider. |
| `live-openai` | Journey (@module-tag): streams from the real OpenAI API; needs OPENAI_API_KEY and OPENWORK_EVAL_LIVE_OPENAI=1, so lanes without them skip it. |
| `packaged` | Journey (@module-tag): boots a packaged desktop build; needs OPENWORK_EVAL_ELECTRON_BINARY, so lanes without one skip it. |
| `raw-desktop` | Journey (@module-tag): drives a raw desktop host (`desktop` from @openwork/hosts) that no CI lane provides; run it by hand, it is never scheduled. |
| `macos` | Journey (@module-tag): needs a macOS host (native AppKit or Computer Use); other lanes skip it. |
| `engine-v1` | Registered case: a test titled with its case ID (e.g. HOME-01) that runs on engine v1; run it with `pnpm evals:e2e <spec> --case <ID> --engine v1`. |
| `engine-v2` | Registered case: a test titled with its case ID (e.g. HOME-01) that runs on engine v2; run it with `pnpm evals:e2e <spec> --case <ID> --engine v2`. |
<!-- tags:end -->

### How CI picks journeys

| Check | Question | Trigger |
| --- | --- | --- |
| Build and core checks | Does the app build, and do foundational behaviors work? | Pull requests and pushes to dev |
| Critical user journeys | Can users start the app, set up a team, and recover a server switch? | Eligible Warden-cleared PRs, or manual critical selection |
| Full regression | Do all supported automatic journeys work together? | 06:00 and 18:00 UTC, or manual full selection |
| Full regression — component checks | Do broader Linux/macOS component, PR, and engine checks pass? | Nightly at 07:37 UTC |
| Test reliability | Are repeated PR-suite results consistent? | Nightly at 04:17 UTC |

GitHub Actions coordinates the checks. Daytona provides isolated environments
for most journeys; local jobs run on the isolated CI computer itself. Both
contribute to one Product journeys verdict. Workflow filenames and build-check
job IDs stay stable for API consumers and branch rules.

`evals/scripts/journeys.mjs` asks Vitest to collect the specs with its static
parser (`collect` with `staticParse`, which never imports spec code) and builds
the plan from the [tags](#journey-tags): placement (`local-only`, or
`raw-desktop` for manual-only specs), model (`live-model`) and lane
prerequisites (`packaged`, `macos`, `live-openai`). A journey whose
prerequisites the lane cannot meet is reported as skipped with its reason. The
planner and the required-verification authorization job therefore install the
evals dependencies. Select a tag group with a `--tags-filter` expression, e.g.
`pnpm --dir evals exec vitest list --project e2e --tags-filter 'critical && !live-model'`.

- New `evals/specs/*.e2e.test.ts` files automatically enter full regression.
  Raw-desktop specs (they import `desktop` from `@openwork/hosts`) stay manual.
- PR selection runs every `critical` journey plus any changed journey file.
  The critical specs (three today) cover startup, the two-person team
  lifecycle (including real model/skill use), and atomic enrollment recovery.
- For PR required verification, the trusted controller copies only the PR's
  spec files into an empty directory and has Vitest from the default-branch
  checkout statically parse them as data; no PR config, world, dependency or
  spec code runs. An existing spec keeps the default branch's tags, and
  removing a critical spec blocks the plan.
- Warden authorization, same-repository restrictions, head-SHA checks,
  protected review-machinery guards and environment approvals still apply.
  Changes to the CI scripts themselves also need scheduled/manual validation.
  A withheld plan never receives a passing coverage report.
- A manual run chooses `suite=full` or `suite=critical`, with an optional
  filename substring `only`; an unmatched filter fails instead of reporting a
  green empty run. The test checkout and remote product are pinned to the SHA.

Every plan lists coverage gaps; “full regression passed” means all selected
automatic coverage, not every scenario or manual test. The critical verdict is
not a required branch rule yet; inspect run durations before enlarging it.

### Read the result

The summary counts **spec files**, each of which may contain multiple tests.

- **Passed:** tests passed with no skips and evidence judging completed.
- **Failed:** a test or evidence judgment failed. The product, test, or fixture
  can be at fault; investigate (`diagnose-a-red-run`).
- **Not tested:** setup failed, tests skipped, the result is missing, or
  execution or evidence validation was incomplete. It never counts as passed.

The plan, results, final report, raw logs, and artifacts are attached to the
run. A failure in one job doesn't cancel the rest. Results describe the tested
revision; a new commit requires new verification.

### Slack alerts

1. Create a Slack app with bot scope `chat:write`, install it, and invite the
   bot to the team's test-alert channel.
2. In repository Settings → Secrets and variables → Actions, create secret
   `SLACK_BOT_TOKEN` and variable `SLACK_TEST_ALERT_CHANNEL_ID`.
3. Optionally set `SLACK_TEST_ALERT_TEAM_ID` to a Slack user-group ID
   (e.g. `S0123456`); new failures mention that group, recurring ones don't.

See Slack's [chat.postMessage setup](https://docs.slack.dev/reference/methods/chat.postMessage/).
Keep tokens in Actions secrets, never in files or PR comments.

Only completed **scheduled** runs notify, and healthy runs are quiet. An
incident starts one channel message; following failures reply in its thread;
one recovery reply closes it. Component and reliability runs have their own
threads. Incident state lives in Actions artifacts for up to 90 days;
out-of-order results don't overwrite newer state, and an expired state starts a
fresh thread. Delivery is not exactly-once: a crash between posting and saving
state can duplicate a message. Missing credentials or a Slack error fail the
notification job visibly.

Verify this plumbing with `node --test evals/scripts/journey-ci.test.mjs`
(selection, result handling, threading, recovery, escaping, failed delivery);
it runs in the PR core-check job. Dispatch Product journeys with
`suite=critical` to exercise the real critical journeys; manual runs send no
Slack messages.

## Why this changed

An audit of OpenWork Tests runs created August 28–September 3, 2026 (UTC)
found 159 failures among 632 runs, including 17 awaiting approval. Among the
615 success/failure results, 25.9% failed. These are run counts, including
repeated branch updates, not a measured flake rate.

Sampled failure logs show different problems that need different fixes:

- [September 3](https://github.com/different-ai/openwork/actions/runs/33814401384):
  `spec-impact` and `spec-quarantine` inventory assertions failed on both OSes
  while 115/116 other spec files passed. Those specific specs have since been
  removed; keeping test-framework bookkeeping out of the default gate prevents
  rebuilding the same barrier elsewhere.
- [August 28](https://github.com/different-ai/openwork/actions/runs/33215552704):
  a compatibility spec spawned another test runner, obscuring the underlying
  failure behind a wrapper assertion.
- [PR #4442](https://github.com/different-ai/openwork/pull/4442): the shared suite
  failed on the same engine-retirement timing assertion seen in a
  [dev run](https://github.com/different-ai/openwork/actions/runs/33907568505).
  [PR #4439](https://github.com/different-ai/openwork/pull/4439) independently
  repairs that race. Core coverage still exercises real engine eviction and
  reload behavior; the broad test is retained.
- The separate [SDK check on #4442](https://github.com/different-ai/openwork/actions/runs/33916924365)
  failed when schema generation connected to MySQL at `127.0.0.1:3306` without a
  database. That is a setup dependency to fix in the SDK change, not a reason
  to suppress schema-drift validation. This CI cleanup does not fix that branch.

This change adds no tests of tests and no new test files. Runtime savings must
be measured after rollout; reducing four broad PR jobs to two focused jobs is
not itself evidence of a particular wall-clock improvement.
