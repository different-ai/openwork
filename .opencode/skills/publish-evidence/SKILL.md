---
name: publish-evidence
description: Publish test evidence, publish all test runs, update PR verification, or audit red evidence. Use after @openwork/testkit runs.
---

# Skill: Publish Evidence

The orchestrator owns this human-verification step. Publishing makes the
agent-first verdict inspectable; it never decides pass/fail and never reruns a
test.

## Make every claim auditable

- Show the test name and verdict, each claim's assertion evidence, the relevant
  test artifacts, the source test run, and the reproduction command.
- Require one sticky-comment section per claimed test. If a claim has no visible
  test-evidence section, report the PR `Incomplete`.
- Write the `<!-- test-evidence -->` marker. The publisher recognizes old sticky
  markers only to update comments created before the migration.

## Publish the PR head

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

## Refuse misleading evidence

- Never use `--force` to hide a SHA mismatch. Re-run the spec on the PR head.
- Use `--force` only to deliberately publish historical or red test evidence. The
  output is annotated; call the exception out explicitly. Red tapes are valid
  human-verification artifacts and should be published when they explain a
  `Failed` or `Incomplete` verdict.
- Read `BLOB_READ_WRITE_TOKEN` from the environment or the Infisical fallback.
  Without it, still post verdicts with a no-screenshots note.
