---
name: publish-evidence
description: Publish test evidence, publish all test runs, update PR verification, audit red evidence, prove a PR, or declare a PR verdict. Use after @openwork/testkit runs.
---

# Skill: Publish Evidence

The orchestrator owns this verdict and human-verification step. It derives the
verdict from completed evidence; publishing makes that verdict inspectable and
never reruns a test.

## Declare the verdict

- `Passed`: every claim has an observable assertion in the completed test run.
- `Failed`: an assertion disproves at least one expected outcome.
- `Incomplete`: requirements, tooling, or evidence are missing. A skip is always
  `Incomplete`, never `Passed`.
- Prose, screenshots, and recordings do not decide the verdict.

## Make every claim auditable

- Show the test name and verdict, each claim's assertion evidence, the relevant
  test artifacts, the source test run, and the reproduction command.
- Require one sticky-comment section per claimed test. If a claim has no visible
  test-evidence section, report the PR `Incomplete`.
- Write the `<!-- test-evidence -->` marker. The publisher recognizes old sticky
  markers only to update comments created before the migration.

## Publish the PR head

Run checks on the final PR head after any rebase or cherry-pick. Test runs are
bound to a commit SHA, so history rewrites require rerunning and republishing.
After a multi-test run, publish each test run whose `gitSha` matches the PR head:

```bash
pnpm evals:e2e --publish --pr <n> --test-run <dir|name>
```

`evals:e2e --publish` judges pending visual validations in the selected test
run, then publishes it. It publishes existing `@openwork/testkit` evidence, not legacy
flows, and never reruns tests.

- Omitting `--test-run` selects the most recent test run; pass it explicitly
  when several runs exist so each test's evidence is published deliberately.
- Publishing replaces the sticky comment with the selected test run. Confirm the
  final comment shows the test and verdict you intend reviewers to see.
- Exit codes: `0` published, `1` failed claims published (or publish failed),
  `2` pending claims still need judging (set a vision key and rerun).

## Stacked PRs

- Inspect `gh pr view <n> --json baseRefName,headRefName,headRefOid` before
  merging. A merged base can retarget the stack and recreate commits with new
  SHAs, orphaning their evidence.
- Check for stray commits with `git log --oneline <branch> ^origin/dev`. If the
  stack is wrong, cherry-pick only the intended commits onto current `dev`, then
  rerun and republish every check.

## Refuse misleading evidence

- Never use `--force` to hide a SHA mismatch. Re-run the spec on the PR head.
- Use `--force` only to deliberately publish historical or red test evidence. The
  output is annotated; call the exception out explicitly. Red tapes are valid
  human-verification artifacts and should be published when they explain a
  `Failed` or `Incomplete` verdict.
- Screenshots are attached with `gh pr comment --attach` (gh ≥ 2.99). Without it
  the publisher still posts verdicts with a no-screenshots note.
