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
  `.github/workflows/warden-clearance.yml`, `.github/scripts/warden-report.mjs`,
  `.github/scripts/warden-clearance.mjs`, `warden.toml`, or `.warden/`.
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

## Local review

With the model credentials configured, run the pinned CLI:

```sh
pnpm warden:check
```

This reviews committed branch changes against `dev`. For an uncommitted
iteration, `pnpm warden:check --staged` reviews the index. Local security and
confidentiality findings still return a failure at every severity. Missing
credentials, partial analysis, and model errors are incomplete reviews.

## Rollout

Warden runs on every same-repository PR, including drafts. Forks cannot use
the model secret and are skipped.

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
