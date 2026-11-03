# Warden as a fixer

Today Warden reviews a PR and posts findings; someone then has to turn each
finding into a commit. The fixer makes Warden behave like Dependabot for its
own high-confidence findings: it opens a small fix PR against the reviewed
PR's branch, and the author (or their agent) accepts it by merging it or
rejects it by closing it. Warden never merges, never approves its own fixes
and never pushes to someone else's branch.

Status: prototype, off by default (`.github/workflows/warden-fixer.yml`,
`.github/scripts/warden-fixer.mjs`). It runs only by hand from `dev`, and only
when the repository variable `WARDEN_FIXER_ENABLED` is `true`.

## Trigger

- After a complete Warden review of a same-repository PR's current head
  (`warden.yml`, event `pull_request`). The prototype is `workflow_dispatch`
  with the PR number and the Warden run ID. The next step is `workflow_run` on
  Warden, like Warden Clearance, so it runs from `dev` code.
- Never for forks, never through `pull_request_target`, and never on code from
  the PR: the scripts come from `dev`. The PR's files are only patched with
  `git apply`; nothing from the PR is installed, built or run.
- Only when the PR still points at the reviewed head, targets `dev`, and is not
  itself a fix PR.

## Identity and token

- Prototype: `GITHUB_TOKEN` with `contents: write` and `pull-requests: write` on
  that one job. Commits are by `github-actions[bot]`.
- Recommended for rollout: a separate GitHub App ("warden-fixer"), installed on
  this repository only, with Contents and Pull requests write and nothing else.
  It must not be `diff-warden`: the App that approves PRs must never also author
  the code it approves. Create its commits through the API so they are signed.

## Commit vs separate fix PR

Recommend a **separate fix PR** whose base is the PR's branch (one per reviewed
head, branch `warden-fix/<pr>-<head>`):

- The author keeps control of their branch; nothing appears in it without their
  merge. Rejecting is closing a PR; accepting is one merge.
- `require_last_push_approval` and stale-review dismissal keep working: the
  author's merge is the last push, and it triggers normal CI and a fresh Warden
  review on the new head.
- Pushing commits straight onto the PR branch is faster to accept but races the
  author, moves the head under their local work, and would make a bot the last
  pusher. Keep it as an opt-in label later, if ever.

## Which findings qualify

All of:

- `confidence: high` and a `suggestedFix` diff from Warden (now carried in the
  `warden-findings` artifact by `warden-report.mjs`);
- a plain text diff: no renames, new or deleted files, mode changes, binaries or
  paths outside the repository;
- at most 3 files and 40 changed lines, and only files the PR already changes;
- no review or CI machinery (`.github/`, `.warden/`, `warden.toml`,
  `.opencode/`, agent skills): those always need a human;
- at most 5 fixes per review. Everything else stays a comment.

## Loops

- One fix PR per reviewed head: if `warden-fix/<pr>-<head>` exists the run stops.
- A fix PR (`warden-fix/*`) is never fixed again, and it targets a feature
  branch, not `dev`, so it never needs the merge gate.
- `GITHUB_TOKEN` pushes start no workflows, so the fix PR triggers no CI or
  Warden loop. The author's merge into their branch is a normal push: CI and
  Warden run once on the new head, and the fixer acts on that head at most once.

## Accept or reject

- Accept: merge the fix PR into your branch (or cherry-pick its commit). Agents
  can do the same with `gh pr merge <fix-pr>` on the fix PR, which targets their
  branch, not `dev`.
- Reject: close the fix PR. Closing is the signal; the fixer does not reopen it
  for the same head.
- The fix PR body lists each fix and how many findings still need a human.

## Rate limits

- One fixer run at a time (`concurrency: warden-fixer`), one fix PR per head,
  at most 5 fixes and 40 lines each. With the App, add a daily cap per PR
  (for example 3 fix PRs) to bound noise on long-lived branches.

## Kill switch

- Unset `WARDEN_FIXER_ENABLED` (or set anything but `true`): every run is
  skipped. Disabling the workflow in the Actions tab works too. Open fix PRs can
  simply be closed.

## Rollout

1. Run it by hand on a few PRs with known Warden findings; check that every fix
   PR is small and correct.
2. Add the `workflow_run` trigger on Warden (still behind the variable) and the
   dedicated App with API-signed commits.
3. Measure accepted vs closed fix PRs; tighten the qualifying rules if more
   than a few are closed.
