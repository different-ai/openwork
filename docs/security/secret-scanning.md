# Secret scanning

## Scope and rollout

`.github/workflows/secret-scan.yml` runs the MIT-licensed
[Betterleaks CLI 1.8.1](https://github.com/betterleaks/betterleaks/releases/tag/v1.8.1).
The release version and Linux x64 archive SHA-256 are pinned in the workflow;
the checksum is verified before extraction. Actions are pinned to commit SHAs.
No scanner license key, package-manager installation, or provider credential is
required. The Gitleaks Action is not used: its organization license can be free,
but its proprietary EULA is distinct from the MIT scanner's license.

This preparation does **not** establish a reviewed history baseline. Do not
publish an ignore file or claim rollout complete until security review accepts
its individual entries and both enforcement proof runs are complete.

The job runs on PR opened/synchronize/reopened/ready_for_review/edited events
(including retargeting a PR) and pushes to `dev`. It scans Git patches in the
exclusive `base..head` range: the PR base
and head SHAs, or the push's before and after SHAs. This includes intermediate
commits, not only the final working tree; adding then removing a secret in the
same PR still fails. Commits already reachable from the base are not rescanned.
Missing/invalid commit objects fail closed rather than silently skipping a scan.

This is a commit-patch check, not exhaustive secret-novelty analysis. Standard
Git log patches do not include merge-resolution-only changes. We deliberately
do not expand merges against each parent: doing so can report old base content
as new. Separate merge-resolution coverage needs a validated parser strategy;
this initial job does not claim it. Reintroduced content in a new ordinary
commit can also be detected again.

Exit status 0 means clean, 2 means findings, and other nonzero statuses mean a
scanner/setup error; all nonzero statuses fail CI. The repository has active
CodeQL code-scanning analyses, so sanitized SARIF is uploaded to the Security
tab even when findings fail the scan. The job requests only `contents: read`
and `security-events: write`; it never uses `pull_request_target`, PR comments,
or repository secrets. The scanner check does not itself configure required
branch-protection checks.

## Trusted policy and accepted fingerprints

The policy names are `.gitleaks.toml` (Betterleaks-compatible TOML) and
`.betterleaksignore`. CI reads both from the **base commit**, never the PR head.
Before policy is first introduced, it uses embedded default rules with no
fingerprint exclusions. An existing malformed policy fails rather than falling
back. Policy updates take effect only after they land in the trusted base.

The default extension syntax is:

```toml
[extend]
useDefault = true
```

Betterleaks' preferred ignore filename is `.betterleaksignore`; it also supports
`.gitleaksignore`. The explicit flag is still `--gitleaks-ignore-path=PATH` (`-i`).
CI supplies a base-derived file under the runner's temporary directory. A bare
clone is the scan target because an explicit `-i` does **not** prevent automatic
loading of the target directory's own ignore file. The PR's TOML, Expr filters,
ignore files and inline allow comments cannot weaken this job's scanner policy.
No repository scripts, dependencies or hooks are executed. The workflow itself
remains PR-editable under ordinary GitHub Actions semantics: trusted scanner
policy is not a substitute for protected workflow changes and maintainer review.
Changes under `.github/` require Ben's review.

After individual security review, record one emitted, commit-qualified
fingerprint per line in `.betterleaksignore`:

```text
<full-commit-sha>:<repository-relative-file>:<rule-id>:<start-line>
```

Use the actual fingerprint, not a secret hash or value. Deduplicate identical
fingerprints: multiple findings on one line can share one fingerprint. Include
the commit; do not use the broader commit-independent `file:rule:line` form.
Blank lines and whole-line `#` comments are supported; trailing inline comments
are not. LF and CRLF are accepted. Document each accepted entry's fixture/false-
positive rationale without copying credentials, private metadata or scan logs.
Never generate the accepted file automatically from every finding.

## Synthetic fixtures

Prefer unmistakable noncredential placeholders. Betterleaks' default
`generic-api-key` Expr filter includes token-efficiency checks; ordinary words
may be rejected automatically. That reduces some generic false positives but
does not classify all findings: the scanner also has URI/password rules.

For local scans, a `gitleaks:allow` or `betterleaks:allow` comment on the matching
line suppresses that line. **CI passes `--ignore-gitleaks-allow`**, so an inline
comment alone cannot make a PR pass. For CI fixtures, request a narrow,
reviewed `.gitleaks.toml` exception in the trusted base first, or use a clearly
nonmatching synthetic value. Prefer exact anchored secret regexes/stopwords,
ideally scoped to the relevant rule, over a whole-file exception when a file
mixes fixtures and production code. Never exclude an entire tests tree.
Retain default lockfile handling rather than duplicating broad exclusions.

`reports/` is Git-excluded; untracked local reports are not Git-history inputs.
Git ignore rules do not remove files already committed. A tracked report must
be reviewed like any other tracked file, not treated as automatically safe.

## Investigating a finding and rotating credentials

1. Stop publication if a finding might be a real credential. Report only the
   file, line, rule and commit through the private channel in
   [SECURITY.md](../../SECURITY.md); do not copy the value into an issue or PR.
2. Have the credential owner revoke/rotate it at the issuer, update consumers
   through their secret store, and check access/audit logs. Do not validate a
   discovered credential against a provider without explicit authorization.
3. Remove the exposed value from current code or reports in a separately
   reviewed change. Deletion does **not** remove the credential from Git
   history, caches, forks or published artifacts. Do not rewrite shared history
   as part of this CI change.
4. Do not add real credentials to the ignore file. A deletion that already
   landed in the base avoids those old commits in subsequent range scans, but
   a full-history scan will still report them. Do not claim that history is
   clean or accept a real finding merely to obtain a green baseline run.
5. For an actual fixture/false positive, review the exact fingerprint and
   rationale, update the accepted file, and rerun the same range and synthetic
   positive-control proofs. Re-review findings when upgrading scanner versions;
   rule/filter changes can change the finding set and fingerprints.

## Local inspection and proof

Use the workflow's pinned release binary in an ignored temporary directory and
verify the platform-specific SHA-256 from the pinned release. The macOS arm64
1.8.1 archive SHA-256 is
`8e80f33b5f2a7426b390347b9fd466033723cb94b6bdffa7572632e2eaec964e`.
Never use a floating `latest` binary to reproduce CI.

The CI scan command, after preparing the base-derived policy and bare clone, is:

```sh
betterleaks git "$HISTORY_REPO" \
  --config="$TRUSTED_CONFIG" \
  --gitleaks-ignore-path="$TRUSTED_IGNORE" \
  --ignore-gitleaks-allow --validation=false --git-workers=0 \
  --log-opts="$BASE_SHA..$HEAD_SHA" \
  --redact=100 --log-level=info --no-color --exit-code=2 \
  --report-format=sarif --report-path="$PRIVATE_REPORT"
```

Full-history triage instead uses `--log-opts='--full-history HEAD'` and a private
redacted JSON report, in a detached worktree. It is a separate review, not the
PR gate. There is no tracked JSON baseline. Keep raw reports in ignored,
owner-only storage: `--redact=100` redacts detected secrets, **not all metadata**.
Never use debug/trace logs or live validation. The workflow strips commit
metadata, finding properties and match context, and forces redacted snippets
before uploading SARIF; paths and rule identifiers necessarily remain visible.
It does not upload the raw report as an Actions artifact.

Before rollout, use a disposable, signed synthetic-secret commit in a
non-allowlisted file. Run the exact CI range command and assert exit 2 plus the
expected finding, remove the disposable commit without rewriting a published
branch, and assert exit 0 for the intended clean range with accepted policy.
Capture commands, exit codes and redacted finding counts, not secret values.
Test scanner errors separately so a missing report cannot become a successful
scan. Full-history findings are never evidence of a passing clean-range proof.

## Runtime redaction is separate

CI detects committed material; runtime redaction protects user data in logs,
diagnostics and tool results before publication. The in-flight
[`feat/shared-secret-redaction`](https://github.com/different-ai/openwork/tree/feat/shared-secret-redaction)
work adds `packages/secret-redaction`. Neither runtime redaction nor this
heuristic CI scanner replaces credential rotation or review of exported data.
