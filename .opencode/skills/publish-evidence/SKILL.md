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

After a multi-spec run, publish every tape whose `gitSha` matches the PR head:

```bash
pnpm fraimz:publish -- --pr <n> --all
```

`fraimz:publish` is an implementation-compatibility command name. It publishes
existing `@openwork/testkit` tapes, not legacy flows.

- `--all` processes matching rolls chronologically and prints why stale or
  malformed rolls were skipped.
- Do not combine `--all` with `--roll`, `--force`, `--dry-run`, or `--open`.
- Publishing accumulates sections in one sticky comment. Publishing a new spec
  preserves existing sections; republishing the same spec replaces only that
  spec's section. Confirm the summary lists every spec and verdict.
- Use `--roll <dir|name>` only to publish one selected existing tape.

## Refuse misleading evidence

- Never use `--force` to hide a SHA mismatch. Re-run the spec on the PR head.
- Use `--force` only to deliberately publish a historical or red tape. The
  output is annotated; call the exception out explicitly. Red tapes are valid
  human-verification artifacts and should be published when they explain a
  `Failed` or `Incomplete` verdict.
- Read `BLOB_READ_WRITE_TOKEN` from the environment or the Infisical fallback.
  Without it, still post verdicts with a no-screenshots note.
