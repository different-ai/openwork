# ENG-76 implementation verification

## Cloud multi-workspace revision — 2026-09-30

Code commits `cc721346f` and `ce9ebb215` replace the earlier fixed
organization/workspace allowlist with the default-off hosted Cloud gate.
The revised browser journey covers two Slack workspaces and two OpenWork
organizations using the same platform app configuration. Workspace-specific
Home grants are stored separately from member read credentials.

### Verification results

- **Functional checks: Passed.** Cold-booted local V2 journey at `f2e559459`:
  `pnpm evals:e2e native-slack-connect --local --engine v2`, exit 0,
  1 passed / 0 failed / 0 skipped, 107 seconds. Placement: `local (--local)`.
  Both pinned engine paths, temporary Chrome, and
  `pnpm_config_verify_deps_before_run=false` were supplied. Receipt:
  `evals/results/.testkit/cli-run-1790785910281-44769.json`.
- `pnpm --filter @openwork-ee/den-api test`: exit 0, **554 passed**, including
  **128 Slack protocol/route/Home tests**, 0 failed / 0 skipped. The full suite
  exposed a missing Slack declaration in the newly rebased audit inventory;
  `slack.ts` is now accurately declared uncovered, matching other native
  connection routes. No audit capture is claimed. The rerun passed.
- `DEN_SLACK_TEST_DATABASE_URL=<disposable loopback database> pnpm --filter
  @openwork-ee/den-api exec tsx --conditions=development --test
  test/slack-installations-db.test.ts`: exit 0, **5 passed**, 0 failed / 0 skipped.
  The new migration was applied to `eng76_slack_installations_test` in Docker.
- Den API and Den DB: `exec tsc --noEmit --pretty false`, exit 0.
- `pnpm api:lint`: exit 0, 0 errors / 39 warnings.
- `pnpm evals:typecheck`: exit 1, the same single
  `mcp-app-servers.e2e.test.ts:10` world-signature error reproduced on clean dev
  in the earlier control run below. No additional eval type error was reported.

Commands use `--config.verify-deps-before-run=false`; the full API suite also
uses the corresponding `pnpm_config_verify_deps_before_run=false` environment
setting for nested commands.

**Automated visual evidence: Incomplete.** The journey records 12 passing
observable expectations, 0 failures, and 11 screenshots awaiting automated
visual validation. The three presentation frames below were inspected manually;
they do not turn unvalidated screenshot artifacts into automated passes.
Full record:
`evals/results/test-runs/2026-09-30T16-31-52-570Z-44800-cloud-members-connect-different-slack-workspaces-without-configuration-and-keep-/`.

![Cloud Slack answer with four conversation categories, links, and a bounded-thread notice](cloud-linked-answer.png)

![Cloud Slack connection with limited access](cloud-limited-access.png)

![Successful authorization in the second synthetic Cloud organization](cloud-second-organization-connected.png)

### Review and resolved failures

Standards review identified an outstanding-database-work admission issue in
Home. The fix retains each admission slot until its underlying operation
settles, even after an HTTP timeout; re-review confirmed the resource bound.
Both review axes requested new verification receipts. A bounded-body-reader
duplication suggestion remains a nonblocking follow-up.

- **Standards:** 3 findings — resource bound and current evidence resolved;
  bounded-reader duplication remains a judgment-call follow-up.
- **Spec:** 1 finding — current multi-workspace acceptance evidence, resolved
  by the receipt above. No implementation blocker or scope creep reported.

The first three browser attempts failed before the app became healthy because
nested pnpm 11 commands tried to reinstall prepared dependencies without a TTY
(`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`). The rerun uses
`pnpm_config_verify_deps_before_run=false`, explicitly forwarded through the
isolated app runtime by the fixture. The runtime strips ambient settings;
pnpm 11 also does not use `npm_config_verify_deps_before_run` for this check.

The new database suite initially exposed two test-harness mistakes: an undeclared
direct `mysql2` import and an epoch-zero timestamp outside MySQL's valid range.
Both were corrected at the test boundary. The next run passed all five tests
against isolated Docker MySQL, including concurrent refresh and encrypted storage.

The first browser run reaching OAuth replacement stopped on an early test
assertion: the prior workspace was still connected while the replacement callback
was finishing. The journey now waits for callback completion and the exact new
identity, rather than accepting any connected account; the subsequent run passed.

Current setup: [Slack Cloud setup](../../slack-cloud-setup.md).
The disposable installation-test database was dropped, the isolated Compose
containers/network removed, and Colima stopped after verification.
The sections below are historical receipts for the superseded internal gate.

## Rebase verification — 2026-09-30

Rebased all ten commits onto `origin/dev` at `628ffa455`. Conflict resolution
preserves dev's audit/App test chains and adds the Slack suites; the OpenAPI
snapshot and SDK were regenerated from the combined routes. The checked code
head is `8ee0bedf4`.

- `pnpm --filter @openwork-ee/den-api test:slack-native`: exit 0, 124 passed.
- `pnpm --filter @openwork-ee/den-web test:slack-native`: exit 0, 11 passed.
- `pnpm --filter @openwork/app exec bun test tests/native-slack-connection-view.test.tsx`:
  exit 0, 12 passed.
- Den API (`exec tsc --noEmit --pretty false`), Den web, and SDK typechecks passed.
- `pnpm api:lint`: exit 0, 0 errors and 39 warnings.
- `pnpm evals:e2e native-slack-connect --local --engine v2`: exit 0,
  1 passed, 0 failed, 0 skipped, 128 seconds. Placement: `local (--local)`;
  cold-booted against the synthetic providers with both pinned engines and
  temporary Chrome. The evidence record has 12 passing expectations and ten
  unvalidated screenshots; automated visual verification remains incomplete.
  Run receipt: `evals/results/.testkit/cli-run-1790775626981-9902.json`.
- App typecheck: exit 2, `mcp-app-frame.tsx:871` uses `Promise.withResolvers`
  outside the configured TypeScript library. The exact single-package command
  reproduced the same error on a clean `628ffa455` control checkout.
- `pnpm evals:typecheck`: exit 1, `mcp-app-servers.e2e.test.ts:10` supplies a
  world with an incompatible second parameter. The exact command reproduced
  the same single error on the clean control after installing both workspace
  dependency sets. Neither type error was introduced by this branch.

Commands above also supplied `--config.verify-deps-before-run=false`.
Generation required rebuilding workspace dependencies added by dev and a
disposable local Docker MySQL schema for auth initialization. The earlier
2026-09-28 suite and screenshot results below describe the pre-rebase tree.

## Result

Native Slack is implemented behind a default-off organization/workspace gate.
The synthetic browser journey passed on implementation commit
`13921ceb3d748c851f7b6ae4ff2b088c32194f1c` (2026-09-28).
This verifies app-web, the pinned V2 engine, Den OAuth/storage, and normal
Connect discovery/execution against synthetic Slack and model HTTP servers.
It is not a packaged-desktop or live Slack acceptance result.

The journey proves member authorization, all four conversation categories,
source links, bounded thread excerpts, two-member private-content isolation,
partial consent, wrong-workspace/organization rejection, retained-capability
denial after disablement, and disconnection of a blocked saved account.

## Checks

Commands use pnpm; `--config.verify-deps-before-run=false` was supplied to avoid
rechecking the already prepared workspace dependencies.

| Command | Result |
| --- | --- |
| `pnpm evals:e2e native-slack-connect --local --engine v2` | Exit 0: 1 passed, 0 failed, 0 skipped |
| `pnpm --filter @openwork-ee/den-api test` | Exit 0: 422 passed, including 124 dedicated Slack tests |
| `pnpm --filter @openwork/desktop test:core` | Exit 0: 156 passed |
| `pnpm --dir evals run test:core` plus targeted reruns | All 11 passed: 8 initially, 3 after selecting the pinned engine (see below) |
| `pnpm test` | Exit 1: app 399 passed; server 201 passed, 1 failed, 1 skipped; later packages not reached by this command |
| Den API, app, Den web, and evals TypeScript checks | Passed |
| API snapshot and SDK generation/typechecking | Passed |
| `pnpm api:lint` | Exit 0: 0 errors, 39 warnings |

The passing journey reports `placement: local (--local)` and uses both
repository-pinned engine binaries plus temporary Chrome-for-Testing.
The earlier automatic run reports `placement: daytona (daytona CLI authenticated)`:
**incomplete, 1 skipped — needs co-located synthetic native HTTP fixtures**.
The user explicitly authorized the additional local run.

The initial eval-core command used the unrelated `opencode` on the shell PATH:
three engine-startup checks failed and eight route checks passed. Each failing
spec then passed individually with the repository-pinned V1 binary selected via
both `PATH` and `OPENWORK_OPENCODE_BIN`: `effective-permissions-attribution`,
`thread-approvals-replay`, and `pdf-attachments-model-routing`. This was an
environment correction; no test or production source changes were needed.

The root-suite failure is `apps/server/src/serve-node.test.ts:126`: a raw HTTP
assertion expects JSON at the end of a chunked response. The same exact targeted
command (`pnpm exec bun --conditions=development test src/serve-node.test.ts`)
reproduced 34 passed/1 failed on both the implementation and clean original base
`8e52796a162badffdac2b9b5998c804114e69bd4`, using Bun 1.4.2.
No transport code or assertions were changed to hide that failure.
The migration test is **skipped — needs `OPENWORK_MIGRATION_LIVE_TEST=1`,
`OPENWORK_MIGRATION_V1_BIN`, and `OPENWORK_OPENCODE2_BIN`**.

## Screenshots

These are actual screenshots from the passing synthetic journey, visually
inspected during implementation. The evidence recorder retains ten screenshots
as unvalidated image artifacts; no automated visual-judging pass is claimed.
Design rules applied: P1 (truthful state), P4 (blocked account remains manageable),
P5 (existing Connect controls), P10 (screenshots), and C5 (neutral blocked state).

![Synthetic Slack answer with source links and incomplete-thread notice](synthetic-linked-answer.png)

![Slack remains connected with limited access](synthetic-limited-access.png)

The full local record is under
`evals/results/test-runs/2026-09-28T14-06-57-367Z-30191-an-internal-member-connects-their-own-slack-reads-linked-excerpts-and-cannot-len/`.

## Review and activation

Standards and spec reviews found and resolved the rotating-user-token response
contract, blocked-account visibility, and accurate policy-owner attribution.
Two duplication suggestions remain nonblocking. Refresh concurrency across
deployment instances remains a separate live-activation check.

No real Slack app, credentials, installation, enablement, or provider outreach
was performed. Live eligibility, minimum in-Slack experience, provider setup,
and packaged OAuth handoff remain pending. See
[the operational draft](../../slack-native-preview-setup.md).

## Local cleanup

The isolated Compose project `openwork-eng-76-validation` was taken down after
verification, removing its MySQL/Redis containers and network. Colima profile
`openwork-eng76-validate` was stopped and its stopped state confirmed.
