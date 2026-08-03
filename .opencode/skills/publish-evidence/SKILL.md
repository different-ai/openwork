---
name: publish-evidence
description: Post the proof, publish the fraimz, put evidence on the PR. Use to publish an existing testkit tape without rerunning tests.
---

# Skill: Publish Evidence

Run:

```bash
pnpm fraimz:publish -- --pr <n> [--roll <dir|name>] [--force] [--open]
```

## Publishing contract

- The publisher selects the newest tape and prints what it selected; use
  `--roll` only to choose a specific tape.
- It refuses a tape whose SHA differs from the PR head. Use `--force` only when
  intentional; the published result is annotated.
- Red tapes are publishable and often should be published.
- Publishing never reruns tests.
- Update one sticky PR comment carrying both `<!-- photo-roll -->` and
  `<!-- fraimz -->` markers.
- Read `BLOB_READ_WRITE_TOKEN` from the environment or the Infisical fallback.
  Without it, still post verdicts with a no-screenshots note.
