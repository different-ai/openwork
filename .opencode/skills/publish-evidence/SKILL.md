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
- Publish one compact sticky comment linking to a report with a section for every
  claimed test. The report must show assertion evidence and original records.
  When the review app is not configured, keep those sections in the comment.
  If a claim has no inspectable evidence, report the PR `Incomplete`.
- Write the `<!-- test-evidence -->` marker. The publisher recognizes old sticky
  markers only to update comments created before the migration.

## Publish the PR head

Run checks on the final PR head after any rebase or cherry-pick. Test runs are
bound to a commit SHA, so history rewrites require rerunning and republishing.
After a multi-test run, publish the complete selection together:

```bash
pnpm evals:e2e --publish --pr <n> --all
# Or select runs explicitly; repeat --test-run for each claimed run.
pnpm evals:e2e --publish --pr <n> --test-run <dir|name> --test-run <dir|name>
```

`--all` selects stored runs matching the current PR head. Include a DocShot
receipt with `--docshot <image.png.review.json>`. It must match that commit too.
Names and captions provide the default report; `--title` and repeatable `--gap`
are optional context. No separate report-writing step is required.

Publication reads recorded evidence. It never runs tests, captures images, or
judges pending visual claims. If visual judging is needed, use the existing
`pnpm --dir evals evidence:judge -- --test-run <dir|name>` command explicitly.
Pending judgments remain visible and make the evidence `Incomplete`.

Set `OPENWORK_REVIEW_URL` and `BLOB_READ_WRITE_TOKEN` to publish to the private
review app. Setup is documented in `apps/review/README.md`. Upload errors must
be reported as publication failures, independently of the test verdict; report
publication is not a required CI check or a release dependency.

- Omitting `--test-run` selects the most recent run. Prefer explicit selection
  or `--all` when making claims about several tests.
- Publication updates the compact comment with the complete selected report.
  Confirm its commit and included tests. Reference images make no pass/fail claim.
- A successful publisher exit means published, not tests passed. Derive the PR
  verdict from recorded results and gaps. Failed and incomplete reports are
  useful evidence and can be published.
- Single-run legacy publication remains available without the review app.

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
