---
name: write-a-spec
description: Write a spec, new E2E test, or test a feature end to end. Use when authoring an @openwork/testkit test in evals/specs.
---

# Skill: Write a Spec

Write new tests in `evals/specs/**/*.test.ts` and import `test` from
`@openwork/testkit`. App-driving E2E tests use `.e2e.test.ts`; the PR lane excludes
them. Model setup as resources in dependency order: `needs()` → `server()` →
`app()`.

## Use the testkit primitives

- `server()` boots or reuses Den and provisions isolated organizations.
- `app()` boots a signed-in desktop. Use `profileDir` for caller-owned profile
  continuity and `localServerDelayMs` for deterministic startup races.
- `inviteMember()` adds a named member to an existing Den.
- `faultProxy()` injects `faults.status()` or `faults.latency()` and exposes the
  `requests` log for assertions about attempts and recovery.
- `eventually()` bounds polling and reports its last value or error.
- `readDenClientState()`, `readConnectState()`, and `readConnectStateFile()`
  expose client, local-server, and persisted-profile state.

## Claims and witnesses

- Make each claim machine-checkable with an observable assertion and its
  explicit negative half. Assert both the intended effect and what must not
  happen to another identity, account, request, file, or state.
- Prose is never proof. Screenshots explain an assertion but cannot replace it.
- Describe product behavior, not incidental layout. Claims such as "side by
  side" can disagree even when pixels are identical across runs.
- Match claims to what the product actually says on screen. If product and
  claim diverge, explicitly change one; never silently bend the claim.
- Never smuggle the answer into the prompt. Assert that the user-facing request
  does not contain connector or resource IDs.

## Evidence contract

- Test evidence is ambient: `screenshot()` records screenshot artifacts,
  `validate()` records their visual validations whether they pass or fail, and
  `recordAssertionEvidence()` holds witness assertions.
- Never create or pass test-evidence recorder handles in test bodies.
- Bound every wait.
- Declare every external requirement in `needs()` so missing dependencies skip
  loudly instead of timing out or weakening coverage.
