---
name: write-a-spec
description: Extend or write a journey spec in evals/specs. Use only after the coverage decision says a journey spec is missing an assertion or a new user journey exists.
---

# Skill: Write a Spec

## Do not write one when…

- An existing journey spec covers the behaviour; extend it.
- The change is a pure function; write a colocated unit test, not evidence.
- You would import `../../apps|packages|ee`, read source files, or spawn another
  test runner. That is a unit test in disguise; the boundary ratchet rejects it.

One spec per user journey, not per PR; bug fixes add an assertion to the journey they escaped from.

Write new tests in `evals/specs/**/*.test.ts` and import `test` from
`@openwork/testkit`. App-driving E2E tests use `.e2e.test.ts`; the PR lane excludes
them. Model setup as resources in dependency order: `needs()` → `server()` →
`app()`.

## Use the testkit primitives

- `server()` boots or reuses Den and provisions isolated organizations.
- `app()` boots a signed-in desktop. Use `profileDir` for caller-owned profile
  continuity and `localServerDelayMs` for deterministic startup races.
- `coworker()` boots the packaged Open Coworker app the same way; it is that
  app's product boundary, and its journeys arrange fixtures through
  `worlds/coworker.ts` rather than importing product source.
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

## Mocks

- Use `mcpMock()` witnesses; never exercise real providers from a spec.
- Witnesses live under `evals/packages/labs/src/`, following `mock-mcp.ts` and
  the provider-specific `mock-*.ts` fixtures.
- Keep witnesses deterministic, identity-scoped, and queryable for assertions.

## Evidence contract

- Test evidence is ambient: `screenshot()` records screenshot artifacts,
  `validate()` records their visual validations whether they pass or fail, and
  `recordAssertionEvidence()` holds witness assertions.
- Never create or pass test-evidence recorder handles in test bodies.
- Bound every wait.
- Declare every external requirement in `needs()` so missing dependencies skip
  loudly instead of timing out or weakening coverage.
