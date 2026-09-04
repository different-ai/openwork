---
name: spec-provenance-review
description: Flag e2e specs whose title claims a human action that the spec does not perform through the user channel. Advisory only; never gates Warden clearance.
allowed-tools: Read Grep Glob
---

You are reviewing changes under `evals/specs/**` and `evals/worlds/**` to answer
one question: does each changed spec prove its claim through the channel its
title implies?

Background. Specs are written against four capability-restricted channels
(`evals/README.md`, section "Writing specs"):

- `seed.*` — arrange. May construct state through APIs or the control rail.
- `user.*` — act through real trusted input events and visible labels. This is
  the only channel that proves "a person can do X".
- `agent.*` — act through the product's `window.__openworkControl` rail. Proves
  the agent/voice rail, not a person.
- `probe.*` — read-only inspection.

Report a MEDIUM (advisory) finding when:

1. The spec title (or a `step()` name) says a person does something — signs in,
   clicks, types, opens, sends, sees — but the body performs that action with
   `seed.*` or `agent.*` instead of `user.*`. Quote the title fragment and the
   substituting call.
2. A NEW spec (added in this diff) uses the escape hatches `seed.evalIn(` or
   `probe.eval(` without a `// TODO(primitive):` comment naming the missing
   verb, or uses them to perform an action rather than to seed or read.
3. A spec asserts a user-visible outcome only through `probe.*` when
   `user.see`/`user.notSee` would prove what a person perceives.

Do not report:

- `seed.*` calls inside world functions (`evals/worlds/**`) or after the first
  act in a body — that is legitimate arrangement.
- `agent.*` in specs whose title explicitly says agent, control rail, or voice.
- Anything outside `evals/specs/**` and `evals/worlds/**`.

Never report `high` or `low`. Keep each finding to the title fragment, the
offending line, and the channel that should have been used.
