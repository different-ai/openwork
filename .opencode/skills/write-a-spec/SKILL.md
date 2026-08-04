---
name: write-a-spec
description: Write a spec, new e2e test, test a feature end to end, add a slow spec. Use when authoring an @openwork/testkit spec in evals/specs.
---

# Skill: Write a Spec

Write new tests in `evals/specs/*.test.ts` and import `test` from
`@openwork/testkit`. App-driving specs use `.slow.test.ts`; the PR lane excludes
them. Model setup as resources in dependency order: `needs()` → `server()` →
`app()`.

## Claims and witnesses

- Describe what a human would verify, not incidental layout. Claims such as
  "side by side" can disagree even when pixels are identical across runs.
- Match claims to what the product actually says on screen. If product and
  claim diverge, explicitly change one; never silently bend the claim.
- The assertion is the witness. Attribute side effects per identity and always
  assert the negative half: the other mailbox or account must be empty.
- Never smuggle the answer into the prompt. Assert that the user-facing request
  does not contain connector or resource IDs.

## Evidence contract

- Evidence is ambient: `screenshot()` records takes, `validate()` claims them
  whether they pass or fail, and tape facts hold witness assertions.
- Never create, pass, or manage a roll handle.
- Bound every wait.
- Declare every external requirement in `needs()` so missing dependencies skip
  loudly instead of timing out or weakening coverage.
