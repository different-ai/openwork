---
name: publish-evidence
description: Publish evidence, publish all tapes, update PR verification, audit a red tape. Use for the human-verification layer after @openwork/testkit runs.
---

# Skill: Publish Evidence

The orchestrator owns this human-verification step. Publishing makes the
agent-first verdict inspectable; it never decides pass/fail and never reruns a
test.

## Make every claim auditable

- Show the spec name and verdict, each claim's assertion or fact, the relevant
  frames, the source tape, and the reproduction command.
- Require one sticky-comment section per claimed spec. If a claim has no visible
  tape section, report the PR `Incomplete`.
- Keep both `<!-- photo-roll -->` and `<!-- fraimz -->` markers.

## Publish the PR head

After a multi-spec run, publish each tape whose `gitSha` matches the PR head:

```bash
pnpm fraimz:publish --pr <n> --roll <roll-directory-name>
```

`fraimz:publish` is an implementation-compatibility command name. It publishes
existing `@openwork/testkit` tapes, not legacy flows. There is no `--all` flag;
run the command once per matching roll under `evals/results/rolls/`. Without
`--roll` it selects the newest roll, which is wrong after a multi-spec run.

- Publishing accumulates sections in one sticky comment. Publishing a new spec
  preserves existing sections; republishing the same spec replaces only that
  spec's section. Confirm the summary lists every spec and verdict.

## Refuse misleading evidence

- Never use `--force` to hide a SHA mismatch. Re-run the spec on the PR head.
- Use `--force` only to deliberately publish a historical or red tape. The
  output is annotated; call the exception out explicitly. Red tapes are valid
  human-verification artifacts and should be published when they explain a
  `Failed` or `Incomplete` verdict.
- The publisher reads `BLOB_READ_WRITE_TOKEN` from the environment, then falls
  back to `infisical secrets get BLOB_READ_WRITE_TOKEN --plain --silent`. When
  a roll has frames and neither source yields a token, publishing fails and the
  error quotes the fallback's failure; fix the token (see `get-env-var`) and
  republish instead of retrying blind.
- Pass `--no-screenshots` only to deliberately post a frameful verdict without
  its frames, and call that exception out in the report and PR comment.
  Facts-only rolls publish normally without a token.
