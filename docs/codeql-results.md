# Missing CodeQL results despite successful jobs

OpenWork uses GitHub's CodeQL **default setup**, not a checked-in analysis workflow.
GitHub can add a language automatically when repository contents change. Existing
PRs may have successful scans from before that change and still lack the newly
required result. The code-scanning merge rule checks uploaded analyses, not just
whether an Actions job is green.

On September 5, 2026, PR #4517 had Actions and JavaScript/TypeScript results for
3427828, but Python was added to default setup after that scan. GitHub consequently
reported one missing result for the PR head or its merge commit e322949.

## Detect

The daily `CodeQL Result Coverage` workflow checks open same-repository PRs targeting the default branch
against successful language uploads at the newest scanned default-branch commit. It reports missing successful uploads
at the current head or merge commit and fails with a PR-specific summary. It does
not execute PR code, change settings, close PRs, or bypass scanning. Active scans
are reported as pending. Forks are excluded because default setup does not scan them.

Run the same read-only audit locally with an authenticated GitHub CLI:

```sh
node scripts/ci/check-codeql-results.mjs 4517
node scripts/ci/check-codeql-results.mjs
```

API failures and missing baselines fail the audit; they are not interpreted as zero required results.
The monitor uses baseline uploads because reading default-setup settings requires
Administration permission, which the workflow token does not have. Newly enabled
languages become expected once their baseline uploads succeed. Results are read
from the latest 100 baseline analyses; old PR history is paginated in full.
This verifies coverage, not absence of vulnerabilities. The existing CodeQL rule
continues to enforce alert thresholds. If switching to advanced setup, update this
audit to use that workflow's categories; it expects the default-setup analysis key.

## Recover

Inspect the failed scan first if one exists. For an old successful default-setup
scan missing a newly enabled language, generate a new push event on the PR branch:

```sh
git status --short
git commit --allow-empty -m 'ci: refresh CodeQL after configuration change'
git push
```

Verify you are on the intended PR branch before committing. This changes the head
SHA, so refresh any evidence that requires the exact head. Re-run the audit once
CodeQL finishes and confirm every configured language has an uploaded result.
A normal upcoming commit also triggers a fresh scan.

GitHub rejected re-running the old generated workflow and manual dispatch for this
incident; closing/reopening the PR did not generate a new CodeQL run. Do not use
those as the recovery procedure, remove a language, or weaken the merge rule.
After changing default setup, run the repository-wide audit to find older PRs
that also need a fresh scan.

References: [Default setup behavior](https://docs.github.com/en/code-security/concepts/code-scanning/setup-types)
and [editing default setup](https://docs.github.com/en/code-security/how-tos/find-and-fix-code-vulnerabilities/manage-your-configuration/edit-default-setup).
