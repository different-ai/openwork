---
name: publish-evidence
description: Publish an existing testkit evidence tape on a PR without rerunning tests.
---

# Skill: Publish Evidence

Run:

```bash
pnpm fraimz:publish -- --pr <n> [--roll <dir|name>] [--force] [--open]
```

`fraimz:publish` is an implementation-compatibility command name. It publishes
an existing `@openwork/testkit` evidence tape; it does not run a legacy flow.

## Publishing contract

- The publisher selects the newest ambient tape and prints what it selected.
- Use `--roll <dir|name>` only when needed to select a specific existing tape.
  This publisher selector is not the prohibited test-author roll-handle API.
- Test authors do not create, pass, or manage roll handles.
- It refuses a tape whose SHA differs from the PR head. Use `--force` only when
  intentional; the published result is annotated.
- Red tapes are publishable and often should be published.
- Publishing never reruns tests.
- Update one sticky PR comment carrying both `<!-- photo-roll -->` and
  `<!-- fraimz -->` markers.
- Read `BLOB_READ_WRITE_TOKEN` from the environment or the Infisical fallback.
  Without it, still post verdicts with a no-screenshots note.
