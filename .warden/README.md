# Warden security review

Warden runs two skills on PRs: new security regressions and public-repository
confidentiality. It does not review design, provenance, or Desktop/Den parity
on PRs; the post-merge sweep (below) checks security, bugs, design and failing
tests on what merged. Those skill files remain available for optional local use.
Rendered UI is reviewed from evidence screenshots instead, where the pixels
and layout exist: see `evals/design-review/README.md`.

Warden is advisory-only: its findings, missing reviews and incomplete analysis
never block PRs or authorize merges. Findings appear in the run summary;
incomplete analysis still fails the workflow job for observability so it cannot
look like a clean review. Warden workflow jobs are not merge requirements.
Warden never leaves review threads, approvals, dismissals or request-changes
reviews.

## Advisory PR reporting

`.github/workflows/warden-clearance.yml` retains its historical name but runs
only as a reporter after each Warden run, from the default branch. It validates
the receipt against the run, attempt, PR and current head, then posts the
`warden-clear` check as the `diff-warden` App: success for a complete, clear
review, neutral for findings or incomplete analysis. This check is not a merge
requirement, and the reporter neither approves PRs nor dismisses earlier
reviews.

The live `dev` ruleset no longer requires `warden-clear`. Required tests,
CodeQL and human approvals remain in force; Warden does not replace or weaken
them. Keep all Warden checks and workflow jobs out of merge requirements.

`diff-warden` keeps one comment on the PR, edited after every run: the advisory
result and why, then each security finding (severity, title, `file:line`,
description). Confidentiality findings appear only as a count; their text could
name the outside identity the rule protects. Model-written text is escaped and
its @mentions are broken, so a finding cannot ping anyone. The repository is
public, so security findings are visible to anyone, as the run summary already
was.

The security skill still reviews workflow changes for concrete CI attack paths,
and Warden's runtime never loads `AGENTS.md` or skills from the PR as
instructions. Receipt validation and trusted policy remain important for useful
feedback, not merge authorization: text in the diff can steer a model.

## Size limits

`warden.toml` and `.warden/contributor.toml` review up to 400 files and
60,000 changed lines per PR (`[defaults.scan]`); the Warden jobs allow 60
minutes. Warden lists files beyond those limits as skipped but doesn't fail
the review for them, so the reporter does: a PR with any file skipped over a
limit is incomplete, and its neutral `warden-clear` check and advisory comment
say to split it; neither blocks merging. Findings from the part that was reviewed
are still posted, marked as incomplete, so authors can act on them.

## Review cost and generated files

The effective standard policy is the repository-root `warden.toml`, not
`.warden/warden.toml`. Its coalescing target is 12,000 characters instead of
Warden 0.43.0's 8,000. Nearby hunks still need to be within 30 lines to merge;
large hunks are still split. This amortizes repeated prompts and extraction
calls without removing any eligible diff lines. Models, verification,
findings thresholds, both skills and scan limits are unchanged. The separate
contributor screen policy is unchanged too.

Do not add blanket ignores for Drizzle metadata, generated SDK code or
OpenAPI. The contract lane regenerates OpenAPI and SDK from source, but an
OpenAPI-only PR currently selects the docs lane and does not run that check.
Drizzle's historical snapshots and journal have no equivalent deterministic
regeneration check. Schema declarations, migration SQL, routes and generators
must remain reviewed, as must confidentiality. Existing Warden built-in
ignores (including generated markers) and size-limit skips are not new
exclusions; size-limit skips continue to make clearance incomplete.

An offline sample of the 30 first-parent commits ending at `50f4d06b8` has
46,342 changed lines; 29,789 (64.3%) are those generated paths. Applying the
pinned CLI's actual filters and scan limits gives 787 → 757 initial analysis
chunks per skill (3.8% fewer), with identical skips and eligible diff lines.
Only one eligible generated-file chunk remains in this sample: most generated
volume already hits size limits or built-in ignores, so raw diff proportions
would greatly overstate possible savings. This is a call-count proxy, not a
claim about billed tokens, total model calls or wall-clock duration.

To reproduce without credentials or model calls, install
`@sentry/warden@0.43.0` with `pnpm add --ignore-scripts` in a separate scratch
package (not this workspace), then point at that package's installation:

```sh
export WARDEN_PACKAGE_ROOT=/path/to/scratch/node_modules/@sentry/warden
node --test .warden/tests/chunking.test.mjs
node .warden/scripts/measure-chunks.mjs 50f4d06b8
node --test .github/scripts/warden-report.test.mjs
```

The offline tests use Warden's own config loader and chunker. The measurement
asserts unchanged skips, files and diff-line order across the whole sample.
The existing CI reporter tests also guard against newly added exclusions,
missing skills or changed scan coverage; neither command calls a model.

## Local review

With the model credentials configured, run the pinned CLI:

```sh
pnpm warden:check
```

This reviews committed branch changes against `dev`. For an uncommitted
iteration, `pnpm warden:check --staged` reviews the index. Local security and
confidentiality findings still return a failure at every severity. Missing
credentials, partial analysis, and model errors are incomplete reviews.

## Fast feedback: re-review only what moved

A full review of a large PR takes about 20 minutes, and every push restarts
it. Two tools give feedback in a few minutes instead. Neither approves
anything; the full review of the exact head also provides advisory feedback only.

Both fingerprint each file's own change: the lines it adds and removes, plus
mode and binary markers, without line numbers or surrounding context. Merging
or rebasing `dev` keeps a file's fingerprint unless `dev` touched the change
itself or a conflict was resolved inside it. Only files whose fingerprint
changed since the last complete review are sent to Warden, with each skill
limited to them through `paths`; findings for the other files carry over.

**In CI**, `.github/workflows/warden-quick.yml` runs on every push to a
same-repository PR. It finds the newest complete review of the PR (the full
review's `warden-findings` artifact or an earlier quick review's
`warden-quick-baseline`), checked against the run, PR and commit it claims.
Like `warden.yml`, it runs only trusted code, policy and skills from the PR's
base and never installs or runs PR code. Warden's agent gets no GitHub token,
and credential-shaped text is redacted from what it writes. Results appear in
the job summary and as annotations on the diff. Confidentiality findings
appear only as a count.
It does nothing for PRs under 15 files (the full review is already quick), for
the first push (no review to compare against yet), or when more than half the
files moved. A finished quick review becomes the next push's baseline; an
incomplete one keeps the earlier findings and saves nothing.

**Before pushing**, `pnpm warden:quick` does the same on your branch against
your last local review, kept in `.git/warden-quick/`. The first run reviews
the whole branch; a change to `warden.toml` or `.warden/skills` on `dev`
starts over. The policy, skills and model catalog (`.warden/pi`) always come
from `origin/dev`, never from the branch under review, so a branch can't steer
the reviewer or send your key elsewhere.
It exits 1 on high or medium security findings or any confidentiality finding,
and 2 when it couldn't review (no `WARDEN_OPENAI_API_KEY`, model errors).
To run it on every push from the checked-out branch, after
`pnpm hooks:install`:

```sh
git config --local openwork.wardenPrePush true
```

The hook runs the reviewer script from `origin/dev`, not from the branch being
pushed. This opt-in local hook blocks a push on high/medium security findings
or any confidentiality finding; CI Warden never blocks PRs. Skip the hook
once with `git push --no-verify`. If the review can't finish, the push goes
ahead. It only reviews when you push `HEAD`, and never commits or pushes.
Like any `core.hooksPath` hook, the hook file itself comes from your checkout,
so enable it only in checkouts whose branches you trust.

Fast reviews see less of the PR at once than the full review, so an
interaction between a moved file and an unchanged one can be missed until the
full review runs. No Warden review grants merge clearance.

## Post-merge sweep: what to fix in what already merged

`.github/workflows/warden-sweep.yml` runs every 3 hours (and on demand) on
`dev`. It reviews each PR merged since the last sweep, one squash-merge
commit at a time so every finding names the PR that caused it, with
`.warden/sweep.toml`:

- `diff-security-review`: the same security skill PRs get.
- `diff-bug-review`: concrete bugs (a trigger and a wrong result), sweep only.
- `design-spec-review`: `DESIGN.md` rule drift in UI code.
- `ui-skills-review`: UI code against pinned rule sets from the
  [UI Skills](https://www.ui-skills.com/mcp/docs) catalog: `baseline-ui`,
  `fixing-accessibility` and `fixing-motion-performance` (ibelick) and
  Vercel's Web Interface Guidelines. `DESIGN.md` wins where they disagree
  (sentence case, skeletons, tracking, shadows), as listed in
  `.warden/ui-skills/header.md`.
- Failing CI: inspect failed jobs and bounded logs for push, scheduled and
  manually triggered workflows on dev. Previous-run conclusions are context,
  not proof that a failure was introduced by a particular merge or is pre-existing.
  Still-running CI is re-checked by later sweeps for up to 24 hours. The current
  dev head and queued CI failures are investigated even with no new merges;
  Warden's own workflows and PR/fork runs are excluded from this repair path.

Results go to the Slack channel in the `SLACK_WARDEN_SWEEP_CHANNEL_ID`
repository variable (via `SLACK_BOT_TOKEN`), only when something needs
fixing. The job summary has the same table; since the repository is public,
security findings appear there only as counts.

### CI failure investigation and suggestions

For up to three failed dev workflow runs per sweep, Warden reads failed-job
metadata and bounded, redacted log excerpts. A tool-free model diagnoses the
failure and suggests a next step. Log text, paths and suggestions are untrusted
input, never commands to execute. The private Slack report includes the diagnosis,
its evidence and suggested fix; the public job summary contains only run links,
counts and fixed disposition categories, not raw logs or model text.

High-confidence source/test defects with a valid current file location enter the
existing small-patch generation and independent verification path. CI repairs may
touch a tracked source file identified by the logs even if that file was not in
the merge diff. A separate draft uses `warden-fix/ci-<run-id>-<source-sha>`; the
writer independently rechecks the failed run's head, attempt and result, current
files and patch limits before opening it. Recovered runs, moved attempts and
existing repair PRs do not generate duplicate fixes.

Workflow/reviewer-policy changes remain manual-review suggestions: generated
patches cannot modify `.github/`, `.warden/` or agent configuration. Missing
credentials, runner outages and inconclusive failures get operator guidance,
not speculative source changes. Never disable tests, weaken assertions, reduce
coverage or loosen security to make CI green. Investigation is log/source review,
not a local reproduction; normal CI must validate any proposed patch.

CI investigation adds at most three diagnosis model calls per run. Proposed
patches share the existing five-attempt generation budget with other findings.
Retries store only run ID, attempt, source SHA and counters (at most 60 entries,
three investigation rounds); exhausted attempts and queue overflow are reported.
No approval, required-check or branch-protection settings change.

**Why the previous sweep never produced patches.** Pinned Warden 0.43.0's
[`FindingSchema`](https://github.com/getsentry/warden/blob/8759014a14130cd2b82e59d3fb450a7385721221/packages/warden/src/types/index.ts)
has confidence, location and verification fields but **no `suggestedFix`**.
Its Zod validation strips unknown fields, so asking the review prompt for
`suggestedFix.diff` cannot repair a ready-diff-only planner. The regression
fixture uses the actual CLI finding shape (without that nonexistent field)
through JSONL parsing, generation, verification and write-job revalidation.

**Generate, verify, then propose a fix.** High-confidence, located security,
bug and design findings (including DESIGN.md and UI Skills) are eligible even
when the review contains no suggested diff. The sweep uses the direct OpenAI
Responses API with strict structured output and `WARDEN_OPENAI_API_KEY`. The
model comes from the trusted sweep policy or the same `WARDEN_MODEL` override;
only `openai/<model-id>` is supported for generation. An unsupported provider
is a visible failure, not a silent fallback. No GitHub/Slack credentials,
execution tools, or environment are sent to the generation/verification model.
Finding and code strings are explicitly untrusted data.

Per run, at most **5 findings** get generation/verification attempts (at most
10 model calls, 120 seconds and 6,000 output tokens each; no hidden HTTP
retries). Up to 3 current tracked regular UTF-8 files from the source merge
are read (located file first, optional small changed-file context), at most
32 KB per source file and **96 KB total including DESIGN.md**. Symlinks in any
path component, path escapes, untracked/binary/oversize files and review/CI
machinery are refused. Each generated fix must use exact, unique current
before/after replacements or explicitly decline with `no_fix`. Deterministic
patches are built in temporary files outside the checkout. Existing suggested
diffs undergo the same patch validation and independent model verification.
The verifier must accept current applicability, root-cause correction,
minimality and preservation of tests, assertions, coverage and security checks;
git independently checks actual patch paths, size and applicability.
Design repairs must preserve DESIGN.md, tokens and existing primitives. Model
acceptance is **not** runtime/test evidence; no tests run in these jobs.

The existing `warden-fixer` caps remain: at most 3 files and 40 added+deleted
lines per fix, at most 5 fixes per PR, only existing files the source merge
changed (or bounded log-located source files for CI repairs), never review/CI
machinery. A separate write-token job revalidates the
artifact identity, source-merge ancestry, file allowlist, current regular files,
patch size and applicability before applying it. It executes no model or project
scripts; Git hooks are disabled. It opens **draft** PRs against dev (one
`warden-fix/merged-<pr>-<sha>` branch per source merge) using the automation App,
which is required so normal CI starts. No token fallback creates unchecked PRs.
Existing deterministic-branch PRs in any state deduplicate retries; an orphan
pushed branch is reused only if its patch is identical. Different branches
require human intervention. Manual `warden-fix/*` follow-ups are also discovered
among the newest 100 open dev PRs: when the body references Warden and the source
PR number, findings in its modified files are deferred for human review rather
than generating competing patches. Up to 5 related PRs / 100 files each are read;
URLs and deferral reasons are reported. This is conservative file-level dedup,
not a claim that the follow-up fixes every finding, and it cannot discover older
PRs beyond that bound or non-Warden branches. Such deferrals remain in the bounded
retry queue. Overlapping verified fixes in one plan are skipped, not blindly
stacked.
Security PR bodies name files, not issue details. Normal CI and human review
are still required; nothing approves, merges or reverts. Set
`WARDEN_SWEEP_FIXES=off` to disable opening (the report explicitly says so).

Slack and public job summaries distinguish findings, generated patches,
verified proposals and planned PRs, with fixed skip/failure reasons. The sweep
never pre-claims a PR was opened. The write job sends actual opened/existing
URLs and failures to Slack and its summary. Model/request/validation failures
fail the sweep after recording state and reporting results; model refusal and
verification rejection remain visible skips. Raw model errors/reasons and
security descriptions are not added to public retry state or diagnostics.
Planned patch artifacts necessarily contain proposed source changes, not raw
finding text; security finding text stays in the private Slack report.

The `warden-sweep-state` artifact stores the last reviewed commit plus a
bounded retry queue of **source commit SHAs and attempt counts only**, never
finding text. Up to 20 new merges and 5 queued commits are reviewed each run.
Incomplete reviews, unresolved findings and plans not yet observed as PRs
remain pending, so a failed/disabled write job is retried. There are at most
60 queued commits and 3 review/generation rounds per source commit; queue
exhaustion/cap retirement is explicitly reported as requiring human action.
Retries re-review source commits against current dev rather than persisting
stale security descriptions. Deferred queue entries retain their attempt count.
To retry after retirement, or recover a previous report-only run, dispatch with
`since` set to the dev commit before the source merge. This does not
retroactively recover findings from runs before this implementation.

Offline regression checks (no credentials or live model/PR/Slack calls):

```sh
node --test .github/scripts/warden-generate.test.mjs .github/scripts/warden-sweep.test.mjs .github/scripts/warden-fixer.test.mjs
```

These cover a missing-diff finding through generated/verified patch and writer
revalidation, all three kinds, unsafe paths/symlinks/edits, failures, budget,
state sanitization and workflow isolation. Quick check runs them without a
workspace build. Live API/model availability and permissions require a real
scheduled/manual run. Locally, without Slack or saved state:

```sh
SINCE=<dev sha> NO_SLACK=1 PI_CODING_AGENT_DIR=.warden/pi node .github/scripts/warden-sweep.mjs
```

### Updating the UI Skills rules

The rule sets are copied into `.warden/ui-skills/rules/` with their source,
sha256 and MIT licenses (`sources.json`, `LICENSES.md`). Warden never fetches
them at review time, because third-party text would become reviewer
instructions without review. To pick up upstream changes, or to add a rule set
to `SOURCES` in the script:

```sh
node .warden/scripts/sync-ui-skills.mjs             # fetch from the UI Skills MCP, re-pin, regenerate
node .warden/scripts/sync-ui-skills.mjs --generate  # after editing header.md, offline
node .warden/scripts/sync-ui-skills.mjs --check     # CI: SKILL.md matches the pins
```

Review the rules diff in the PR like any other policy change.

## Rollout

Warden runs on every same-repository PR, including drafts. `warden.yml` skips
forks: the action only analyzes `pull_request` events, which get no secrets
from forks.

Fork PRs are reviewed by `.github/workflows/contributor-warden.yml` instead,
which runs the pinned Warden CLI from dev against the fork's commits written
to disk as data (symlinks, LFS and filters off; this repository's `.warden/`
and `warden.toml` replace the PR's copies). It only runs after a maintainer
comments `/test`, so opening PRs cannot spend model budget. Maintainer
authorization remains bound to the reviewed commit and the deterministic
contributor screen still holds suspicious input for a person. Once authorized,
tests and the standard Warden review do not wait for the AI screen or its
verdict. The `contributor-screen` skill (`.warden/contributor.toml`) still
reports hidden behavior, obfuscation and supply-chain risk as advisory feedback.
Neither AI result approves the PR or blocks tests or merging; the Warden review
posts the same advisory `warden-clear` check as same-repository PRs. Required
tests and human review remain separate.

Text in a fork's diff can steer the model, and the agent's `Read` tool
accepts any path, including `/proc/self/environ`. So for forks, Warden runs
in a sandbox (`.github/scripts/contributor-warden-sandbox.sh`):

- **No key to steal.** The Warden container gets a placeholder key. Pi's
  `models.json` sends every OpenAI call to a proxy container, which alone
  holds `WARDEN_CONTRIBUTOR_OPENAI_API_KEY` (a separate, spend-limited key).
- **No way out.** The Warden container is on an internal Docker network
  that reaches only the proxy. The proxy forwards only `POST /v1/responses`
  for the configured models, refuses hosted tools (web search, MCP, code
  interpreter, file search) and server-side state, and stops after a request
  budget (`.github/scripts/warden-model-proxy.mjs`).
- **Nothing else to read or change.** Read-only PR files and git objects,
  read-only root filesystem, non-root, no Linux capabilities, no host
  directories.
- **Checked every run.** Before Warden starts, a check inside the container
  fails the run if a real key, the internet, host files or writable PR files
  are visible.

Steering the model itself is resisted in two ways, neither of which is
complete on its own. Every skill that runs on forks starts with an
"Untrusted input" section in its system prompt: the diff, commit messages,
comments and files are data, and text aimed at the reviewer is reported as a
finding. Separately, the deterministic screen holds any PR whose added lines
or commit messages try to address an AI reviewer, imitate prompt tags, or ask
for no findings, without asking a model. A steered model can still lie about
the code, so held items always need a person and Warden never approves a
fork PR. Only OpenAI models work in the sandbox; pointing
`WARDEN_MODEL` at another provider makes fork reviews incomplete.

The workflow reads policy, skills, and the reporter from the PR's immutable
base; proposed policy changes take effect after merging. PR code is inspected,
never installed or executed by the workflow.

To change the CI model without a PR, set the `WARDEN_MODEL` repository variable
(`provider/model-id`, e.g. `openai/gpt-6-luna`). It replaces the `warden.toml`
models for hosted runs; unset it to fall back to `warden.toml`.

Warden's Pi runtime only knows the models in the catalog bundled with the
pinned action. `.warden/pi/models.json` registers newer OpenAI models (such as
`gpt-6-luna`) for CI and `pnpm warden:check`; add a model there before pointing
`WARDEN_MODEL` or `warden.toml` at it. Otherwise every chunk fails immediately
with a misleading authentication error.

The `warden-clearance` environment and App credentials are shared with release
and other automation.

See [reporting.md](reporting.md) for timing and future tracking.
