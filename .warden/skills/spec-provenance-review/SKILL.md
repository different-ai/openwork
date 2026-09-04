---
name: spec-provenance-review
description: Flag concrete false-positive proof introduced by changed specs, not test helper or channel preferences. Advisory only; never gates Warden clearance.
allowed-tools: Read Grep Glob
---

Review changes under `evals/specs/**` and `evals/worlds/**` for one question:
does this diff let a spec pass while the specific behavior it claims to test
is broken?

Test code has a different purpose from production code. Review the validity
of its evidence, not production hardening, abstraction, style, or preferred
helper usage. Channel conventions in `evals/README.md` are authoring guidance;
a channel mismatch alone is not a finding.

Report a MEDIUM (advisory) finding only when ALL of these hold:

- The changed lines introduce or materially worsen the gap.
- The spec bypasses the behavior under test or asserts evidence unrelated to
  that behavior.
- You can identify a concrete broken behavior that would still pass, grounded
  in the spec and relevant implementation. A hypothetical possibility or the
  availability of a different helper is insufficient.

Examples worth reporting:

- A spec claims a person can submit a form, but directly invokes the API and
  never submits through the UI, so broken form wiring is not exercised.
- A spec claims a save persists data, but only asserts the seeded value and
  never observes the result of saving.
- A spec claims visible success, but checks an internal success flag while
  the implementation demonstrably never renders the result.

Do not report:

- Read-only DOM/CDP inspection, `evaluateOnSurface`, `document.body.innerText`,
  or `probe.*` merely because `user.see`/`user.notSee` could be used instead.
  For example, opening `/pricing` and asserting new prices in rendered body
  text is acceptable pricing evidence; the title saying "visitors see" does
  not by itself require a different helper. Report only if the implementation
  shows that the asserted text does not prove the specific claimed outcome.
- `seed.*`, direct API calls, or browser evaluation used to arrange state,
  including setup between actions; report only when setup substitutes for
  the behavior actually under test.
- `agent.*` in specs testing the agent, control rail, or voice.
- Missing `// TODO(primitive):` comments or helper migration suggestions.
- Test-only shortcuts, mocks, or fixtures that do not invalidate the claim.
- Pre-existing gaps, title wording alone, or anything outside the scoped paths.

Never report `high` or `low`. Each finding must quote the claimed behavior,
identify the changed line that bypasses it, explain the concrete failure that
would still pass, and suggest the smallest fix. If that evidence is missing,
report nothing.
