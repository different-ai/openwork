# evals/AGENTS.md

Tests and E2E proofs. The human guide is [`docs/testing.md`](../docs/testing.md);
this file is the short version. Mechanics (worlds, channels, CLI) are in
[`README.md`](./README.md).

## Paved path

Load the skills in order: `write-a-spec` → `run-tests` → `diagnose-a-red-run`
(when red, before changing code) → `open-a-pr`. CI runs every spec the PR
changes on its head and posts the proof; you never publish by hand.

## User flow vs agent flow

Tag every test `user-flow` (a person in the real UI; each step ends with a
screenshot) or `agent-flow` (an agent, MCP client or server; the proof is the
requests and responses). **If a person can see or click the change, the PR
needs a user-flow spec**, and its Evidence lists the user flow first.
[docs/testing.md#user-flow-vs-agent-flow](../docs/testing.md#user-flow-vs-agent-flow)

## Add a journey

```bash
pnpm evals:new <kebab-name> [--flow user|agent] [--engine v1,v2] [--critical] [--world <file>.ts:<export>]
pnpm evals:e2e <kebab-name> --local
```

A journey is one `specs/<name>.e2e.test.ts`; there is no list to edit.

- The first line of the JSDoc block at the top is its readable name;
  `@module-tag` lines there tag the whole file (`critical`, `local-only`, …).
- `user-flow`/`agent-flow` and `engine-v1`/`engine-v2` go on each test's
  `{ tags }`. An engine-tagged test's title starts with a unique case ID
  (`"HOME-01 …"`).
- List the declared tags: `pnpm --dir evals exec vitest --list-tags`. New tags
  go in `vitest.config.ts` with a description, then `pnpm --dir evals docs:tags`.

[docs/testing.md#add-a-journey](../docs/testing.md#add-a-journey) ·
[#journey-tags](../docs/testing.md#journey-tags) ·
[#how-ci-picks-journeys](../docs/testing.md#how-ci-picks-journeys)

## Hard rules

- A spec imports only `@openwork/testkit`, `vitest` and its world from
  `../worlds/`. No product source (`../../apps|packages|ee`), `node:fs` or
  `child_process` (boundary ratchet).
- No raw escapes in new specs: `seed.evalIn`, `probe.eval`, `client.send`,
  `localStorage.setItem`, `denFetch` (channel ratchet).
- Every new `spec.world(...)` declares `resources: { surfaces, services }`.
- Only `seed.*` writes state, in the world, before the first step.
- Worlds never import `vitest` or `@openwork/testkit` (`pnpm --dir evals lint:layers`).
- Prose is never proof: every claim has an assertion and
  `evidence.recordAssertionEvidence`; a skip is not a pass.

## Check before pushing

```bash
pnpm --dir evals typecheck
pnpm --dir evals test          # layers, ratchets, journey + tag-doc checks
```
