# Warden security review

Warden runs two skills: new security regressions and public-repository
confidentiality. It does not review design, provenance, or Desktop/Den parity
automatically. Those skill files remain available for optional local use.
Rendered UI is reviewed from evidence screenshots instead, where the pixels
and layout exist: see `evals/design-review/README.md`.

Findings appear in the run summary; incomplete analysis fails the job so it
cannot look like a clean review. Warden never leaves review threads or
request-changes reviews.

## Clearance (automatic approval)

`.github/workflows/warden-clearance.yml` runs after each Warden run, from the
default branch, and approves the PR as the `diff-warden` App when all of these
hold:

- The PR is from this repository (forks are never reviewed or approved) and is
  still open at the analyzed head commit.
- Both skills completed, and the receipt matches the run, attempt, PR, and head.
- No high or medium security findings. Low findings are noted, not blocking.
- No confidentiality findings at any severity.
- The PR does not change Warden itself: `.github/workflows/warden.yml`,
  `.github/workflows/warden-clearance.yml`, `.github/workflows/warden-quick.yml`,
  `.github/scripts/warden-report.mjs`, `.github/scripts/warden-clearance.mjs`,
  `.github/scripts/warden-fast.mjs`, `warden.toml`, or `.warden/`.
  `warden.yml` runs inside the PR's own review and could forge its result; the
  others would let one PR rewrite the reviewer for every later PR.

Other CI workflows, `AGENTS.md`, and agent skills are approvable. The security
skill reviews workflow changes for concrete CI attack paths, and Warden's
runtime never loads `AGENTS.md` or skills from the PR as instructions.

Otherwise it dismisses any earlier `diff-warden` approval. A new push dismisses
the approval through the branch rule, and the next Warden run decides again.

Either way, `diff-warden` keeps one comment on the PR, edited after every run:
approved or not and why, then each security finding (severity, title,
`file:line`, description). Confidentiality findings appear only as a count;
their text could name the outside identity the rule protects. Model-written
text is escaped and its @mentions are broken, so a finding cannot ping anyone.
The repository is public, so security findings are visible to anyone, as the
run summary already was.

The approval only unblocks merges if the `dev` ruleset accepts it. With a
required `openwork-reviewers` team review, an App approval cannot count, so
that team requirement must be removed for clearance to merge PRs. Then any
approval from someone with write access counts too. The model can be steered by
text in the diff it reviews, so clearance is a judgment call, not a guarantee.

## Size limits

`warden.toml` and `.warden/contributor.toml` review up to 400 files and
60,000 changed lines per PR (`[defaults.scan]`); the Warden jobs allow 60
minutes. Warden lists files beyond those limits as skipped but doesn't fail
the review for them, so the reporter does: a PR with any file skipped over a
limit is incomplete, never clear, and its `warden-clear` check and comment say
to split it. Findings from the part that was reviewed are still posted,
marked as incomplete, so authors can act on them.

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
anything: clearance still comes only from the full review of the exact head.

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
pushed. It blocks a push only on findings CI's Warden would block on; skip it
once with `git push --no-verify`. If the review can't finish, the push goes
ahead. It only reviews when you push `HEAD`, and never commits or pushes.
Like any `core.hooksPath` hook, the hook file itself comes from your checkout,
so enable it only in checkouts whose branches you trust.

Fast reviews see less of the PR at once than the full review, so an
interaction between a moved file and an unchanged one can be missed until the
full review runs. That is why they never clear a PR.

## Rollout

Warden runs on every same-repository PR, including drafts. `warden.yml` skips
forks: the action only analyzes `pull_request` events, which get no secrets
from forks.

Fork PRs are reviewed by `.github/workflows/contributor-warden.yml` instead,
which runs the pinned Warden CLI from dev against the fork's commits written
to disk as data (symlinks, LFS and filters off; this repository's `.warden/`
and `warden.toml` replace the PR's copies). It only runs after a maintainer
comments `/test`, so opening PRs cannot spend model budget. It first runs the
`contributor-screen` skill (`.warden/contributor.toml`): hidden behavior,
obfuscation and supply-chain risk. When that is clear, or the maintainer
comments `/test` again, it runs the two standard skills. Neither result
approves the PR; they feed the `contributor-pr-required` status.

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
