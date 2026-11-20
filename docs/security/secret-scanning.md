# Secret scanning

## What runs

`.github/workflows/secret-scan.yml` runs checksum-pinned, MIT-licensed
[Betterleaks 1.8.1](https://github.com/betterleaks/betterleaks/releases/tag/v1.8.1)
on pull requests (opened, synchronize, reopened, ready_for_review, edited) and
pushes to `dev`. Actions are SHA-pinned. No license key is required.

The gate scans ordinary Git commit patches in `base..head` for PRs and
`before..sha` for pushes, including intermediate commits. A secret added then
removed within that range still fails. Commits already reachable from the base
are not scanned. Missing or invalid SHAs fail closed. Exit 0 means no findings;
exit 1 means findings or an error, and every nonzero exit fails CI.

The job uses `--redact=100`, disables live credential validation, and uploads
sanitized SARIF to GitHub's Security tab, including when findings fail the job.
Sanitization removes commit metadata, finding properties, match context and
fingerprints, and replaces messages/snippets with fixed redacted text. Raw
reports are not uploaded as artifacts. Permissions are `contents: read` and
`security-events: write`; no repository secrets or PR comments are needed.
This workflow does not configure required branch checks or push protection.

## Policy and review

CI loads an established `.betterleaks.toml` from the **base commit**, not the PR
head. Only the initial installation, when the base has no policy, bootstraps
from the head and emits a maintainer-review notice. Ben must review that initial
policy with this workflow. Later policy changes require review and take effect
after merging into the base. Missing or malformed bootstrap policy fails closed.
A bare clone and a temporary working directory prevent PR-controlled config or
ignore-file discovery. Inline allow comments are ignored. No repository code,
hooks or dependencies are executed. Workflow edits remain subject to ordinary
GitHub Actions PR semantics and require Ben's review; trusted policy is not a
replacement for protecting workflow changes.

The config extends the default rules without disabling `generic-password` or
`generic-credential-uri`. Its global `prefilter` and `filter` use Betterleaks
1.8.1's **Expr** syntax (not CEL); `true` means discard. These global expressions
replace the corresponding default expressions; the JavaScript lockfile exclusion
is retained explicitly, and default per-rule filters remain enabled.

Reviewed path classes are annotated individually in the config:

- `**/test/**`, `**/tests/**`, `**/testdata/**`, `**/*.test.*`, `**/*.e2e.*`:
  synthetic test data and test modules.
- `evals/**`: evaluation harnesses/fixtures, **except the unresolved report**.
- `**/*.example` (including `**/.env.example`): instructional configuration.
- `**/docker-compose*.yml`, `packaging/**/values*.yaml`: local deployment defaults.
- `packaging/**/README.md` (including `packaging/docker/README.md`): deployment
  instructions.
- `scripts/build-microsandbox-openwork-image.sh`: sandbox-image build defaults.

Path exclusions are deliberately broad and can hide actual secrets in those
classes; never put live credentials in fixtures. The historical July token is
outside this PR's commit range, remains untouched and explicitly not path-exempt,
and its disposition belongs to Ben on Monday.

The literal filter accepts only `changeme`, `example`, `YOUR_TOKEN`,
`YOUR_API_KEY`, `YOUR_PASSWORD`, and the `postgres:postgres` URI tuple on
`localhost`/`127.0.0.1`. It does not accept strings merely containing those words.
To propose an exception, add a narrowly anchored path class or exact literal
with a one-line rationale, request review, and rerun the positive and negative
controls below. Never add an issued credential to the filter. There is no ignore
file, fingerprint list or baseline.

## Reading a failure

1. Check the job status and Security findings for file, line and rule. An error
   or missing SARIF is not a clean scan.
2. If potentially real, report only location/rule privately using
   [SECURITY.md](../../SECURITY.md). Do not paste values into PRs, issues or logs.
3. Have the owner revoke/rotate the credential, update consumers through their
   secret store, and check issuer audit logs. Do not probe it for validity.
4. Remove exposures in a separately reviewed change. Deleting current content
   does not remove history, forks or caches. Do not rewrite history in this PR.
5. If synthetic, prefer nonmatching placeholders or a reviewed policy change;
   do not silence a whole rule to get a green run.

The private pre-existing 619-row inventory is not an accepted baseline: 455 rows
match the reviewed path classes, while 164 remain unexempted before literal
filtering (52 URI, 102 password, 7 PostHog project-key, 3 generic-key findings).
These are **to triage**, not a declaration that they are live or all false
positives. Redacted historical rows alone do not establish exact literal values.

## Local reproduction

Use the pinned CLI in ignored `tmp/`, verifying the release archive checksum.
The macOS arm64 archive SHA-256 is
`8e80f33b5f2a7426b390347b9fd466033723cb94b6bdffa7572632e2eaec964e`;
the Linux x64 checksum is pinned in the workflow. Keep raw reports owner-only:
redaction covers detected values, not every possible secret in surrounding text.

After preparing a bare clone and copying the reviewed policy to a private
temporary directory, run from that directory:

```sh
betterleaks git "$HISTORY_REPO" \
  --config="$TRUSTED_CONFIG" \
  --ignore-gitleaks-allow --validation=false --git-workers=0 \
  --log-opts="$BASE_SHA..$HEAD_SHA" \
  --redact=100 --log-level=info --no-color --exit-code=1 \
  --report-format=sarif --report-path=secret-scan.raw.sarif
```

Required proofs use the pinned **local binary**, not a hosted service:

1. A disposable signed commit containing a synthetic AWS key pair and GitHub PAT
   in a nonexempt path: exit 1, both rule IDs, redacted; then reset that unpublished
   commit. AWS's literal `EXAMPLE` suffix is ignored by default, so use an
   unissued synthetic ID of the same shape and its required paired secret.
2. The same command on `origin/dev~5..origin/dev`: exit 0.
3. A synthetic credential URI under `tests/`: exit 0; identical nonexempt content
   must still be detected.
4. `tmp/betterleaks config check --config .betterleaks.toml`: exit 0.

`pnpm evals:pr specs/ci-secret-scan.test.ts` automates these controls using
isolated repositories; set `BETTERLEAKS_BIN` if the verified binary is elsewhere.

## Boundaries and follow-ups

This is not a full-history scan, a live-secret validity check, or exhaustive
secret detection. Plain Git log patches miss merge-resolution-only changes.
No scheduled job is added. Follow-ups, **not implemented here**:

- Weekly full-history **reporting** scan.
- Ben: disposition of the July report (also tracked as the 2026-07-22 report)
  and archived sandbox; this PR does not modify either.
- Guillaume: GitHub push-protection toggle.
- Runtime redaction: `packages/secret-redaction` on sibling branch
  [`feat/shared-secret-redaction`](https://github.com/different-ai/openwork/tree/feat/shared-secret-redaction).
  Runtime output protection and committed-secret scanning serve different roles.
