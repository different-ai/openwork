# Warden security review

Warden runs two skills: new security regressions and public-repository
confidentiality. It does not review design, provenance, or Desktop/Den parity
automatically. Those skill files remain available for optional local use.

GitHub's existing `openwork-admin-reviewers` approval rule owns merge approval,
including changes to `.github/`, CI, and Warden itself. Warden has no separate
path veto, approval bot, request-changes review, or unresolved review threads.
Security findings are advisory in the run summary; incomplete analysis fails
the job so it cannot look like a clean review. Warden must remain an optional
check in the branch rules. No branch rules are changed by this setup.

## Local review

With the model credentials configured, run the pinned CLI:

```sh
pnpm warden:check
```

This reviews committed branch changes against `dev`. For an uncommitted
iteration, `pnpm warden:check --staged` reviews the index. Local security and
confidentiality findings still return a failure at every severity. Missing
credentials, partial analysis, and model errors are incomplete reviews.

Run the reporter's contract tests without model credentials:

```sh
node --test .github/scripts/warden-report.test.mjs
```

## Rollout

The repository's Warden workflow is currently disabled in GitHub. The new
workflow declares PR triggers, but this change does not enable the live
workflow. After merging and reviewing the first run, a maintainer can enable
Warden in Actions and synchronize/reopen a same-repository PR. Forks cannot
use the model secret and are skipped. Draft PRs are included.

The workflow reads policy, skills, and the reporter from the PR's immutable
base; proposed policy changes take effect after merging. PR code is inspected,
never installed or executed by the workflow. The first rollout PR does not
have the new reporter on its base yet and cannot demonstrate a hosted run of
the new reporter. Validate on a subsequent PR after enabling.

The `warden-clearance` environment and App credentials are still used by
release and other automation. Removing the Warden approval workflow does not
remove those shared credentials or change existing reviews and threads.

See [reporting.md](reporting.md) for timing and future tracking.
