# Test Evidence and Test Artifacts Program

OpenWork's executable verification records assertions, visual validations, and
screenshots as one test run. Test evidence determines whether a claim is
auditable; screenshots and HTML views are test artifacts, not standalone proof.

## Current contract

`@openwork/test-evidence` provides the ambient recorder used by
`@openwork/testkit`:

- `screenshot()` captures a `ScreenshotArtifact` and records it ambiently.
- `validate()` records visual expectations against the matching screenshot.
- `recordAssertionEvidence()` records nonvisual observable assertions.
- `createVisualEvidence()` is available to the small set of standalone E2E
  tests that explicitly own visual-evidence recording.

Each completed test writes:

```text
evals/results/test-runs/<test-run-id>/
├── test-run.json
├── index.html
└── <ordered screenshot artifacts>.png
```

The `test-run.json` schema calls its ordered entries `artifacts`. The summary
counts passed, failed, pending, and unvalidated artifacts plus expectation
judgments. Git SHA and branch metadata bind publication to the tested commit.

## Artifact indexing and publication

`@openwork/test-artifacts` owns compatible reading, the local artifact index,
and PR publication:

```bash
pnpm --dir evals artifacts:index
pnpm --dir evals artifacts:publish -- --pr <n> [--test-run <path|directory-id|latest|name>] [--dry-run]
pnpm --dir evals evidence:judge -- --test-run <path|directory-id|latest|name>
```

The publisher uploads screenshots under
`test-artifacts/<test-run-id>/<artifact-name>` and writes the sticky
`<!-- test-evidence -->` PR comment. Publishing never decides pass/fail and
never reruns a test.

## Persisted compatibility

Compatibility is intentionally read-only:

- Indexers and publishers still read pre-migration
  `evals/results/rolls/*/roll.json` records and normalize their `frames` entries
  to test artifacts.
- Loose legacy-runner directories containing `fraimz.html` remain indexable.
- The PR publisher recognizes `<!-- photo-roll -->` and `<!-- fraimz -->` only
  to replace an existing sticky comment; newly written comments use only
  `<!-- test-evidence -->`.

There are no deprecated package, TypeScript API, script, binary, or CLI aliases.
The frozen `evals/flows/**` corpus and its legacy runner reports are outside the
current authoring path.

## Verification path

New app-driving coverage uses `evals/specs/*.e2e.test.ts` with `test` from
`@openwork/testkit`. Run one test with `pnpm evals:e2e <name>` and publish the
result through `publish-evidence`. Missing or skipped evidence is `Incomplete`,
never `Passed`.
