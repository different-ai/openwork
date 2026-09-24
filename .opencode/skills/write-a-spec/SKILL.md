---
name: write-a-spec
description: Write or extend an E2E journey spec in evals/specs that proves a PR's change to a human reviewer. Use when a PR changes user-visible behaviour, when a reviewer asks "show me", or when the coverage decision says a journey is missing.
---

# Skill: Write a Spec

Every `evals/specs/**/*.e2e.test.ts` a PR adds or changes runs in CI on the PR
head and is published as that PR's proof (private report + one PR comment).
Write the spec for the person who will read that report in thirty seconds,
not for the machine that runs it.

## Do not write one when…

- An existing journey covers the behaviour: extend it. One spec per user
  journey, not per PR; bug fixes add a step to the journey they escaped from.
- The change is a pure function: write a colocated unit test, not evidence.
- You would import `../../apps|packages|ee`, read source files, or spawn another
  runner. That is a unit test in disguise; the boundary ratchet rejects it.

No UI does not mean no spec. A server, proxy, or protocol bug gets a
browser-less world (see `evals/specs/session-title-recovery.test.ts`); the
steps still read as one person's before → after.

## The proof shape

A proof answers: **who** can now do **what** they could not before, and who
still cannot. Structure every spec as that story. Each beat is one `step()`
with a claim-sized name; each visual beat ends in `user.screenshot()`.

```
persona  → the test title names a person: "an owner", "a teammate", "a member without access"
before   → what that person sees or cannot do today (features only)
action   → the person does the thing, through the UI, as they would
after    → what they now see; screenshot at that moment
boundary → who else is affected, and the negative half: who is not
```

The review app is generated from the spec. It shows exactly four strings, and
each comes from one place in your code; write those strings for the reviewer:

| Reviewer sees | Comes from | Rule |
| --- | --- | --- |
| Section heading | the `test("…")` title | names the persona and what they can now do |
| Caption under a screenshot | the `step("…")` the `user.screenshot()` ran inside | the old state starts `before:`, the new state `after:`; otherwise a plain claim |
| Caption + judgment on a `looks()` image | the first expectation in `user.looks([...])` | judged later; pending until then, so CI proof stays `Incomplete` |
| Assertion line | `recordAssertionEvidence(claim, evidence, ok)` | `claim` is the caption, `evidence` the text under it |

A screenshot taken outside any `step()` is captioned "<title> artifact N",
which tells the reviewer nothing. No verbs like "assert", no selectors, no
internal names anywhere in those strings.

Example title and steps:

```ts
test("an owner enables Code Mode and a teammate turns one chat into a shared Workflow", async ({ user, probe, step }) => {
  await step("before: the teammate's agent has no script tool", …);        // screenshot
  await step("the owner enables Code Mode with one switch", …);             // screenshot
  await step("after: the teammate's request runs as one script", …);        // screenshot
  await step("the result is saved as a Workflow the team can open", …);    // screenshot
  await step("a member outside the team cannot see it", …);                // screenshot
});
```

Assertions still live inside each step; they just hang off user-visible
moments. A spec whose assertions are RPC responses collected in the world and
compared in one block is a mechanism check, not a proof. It is still allowed;
it just tells the reviewer nothing.

## Same story in three places

The spec, the report, and the PR body tell one story in the same words. Write
the report you want to read first, then make the code produce those lines.
A bug fix with no screen still gets this shape; the "screenshot" is one
`recordAssertionEvidence` line per step whose `evidence` is the observed fact.

Report the reviewer reads (every line comes from the spec):

```
▶ a member's conversation stays readable while OpenWork is still checking who owns it
  ✔ given an engine where the ownership check is slow and the messages read is fast
      GET /session/:id answers in 150 ms; GET /session/:id/message in 2 ms
  ✔ when the member opens the conversation and memory is reclaimed mid-check
      three reads sent as the app sends them; gc() ran three times
  ✔ then the runtime really reclaimed the engine's response
      WeakRef → undefined  (witness; without it a pass means "nothing happened")
  ✔ after: all three reads return the conversation, none say internal_error
      200 / 200 / 200; body {"id":"ses_x", …}
```

Spec that produces it:

```ts
test("a member's conversation stays readable while OpenWork is still checking who owns it", async ({ world, step, evidence }) => {
  await step("given an engine where the ownership check is slow and the messages read is fast", async () => {
    evidence.recordAssertionEvidence("engine timings", `GET /session/:id ${world.ownershipMs} ms; GET /session/:id/message ${world.messagesMs} ms`, true);
  });
  await step("when the member opens the conversation and memory is reclaimed mid-check", async () => { /* act; gc(); */ });
  await step("then the runtime really reclaimed the engine's response", async () => {
    const collected = world.engineResponse.deref() === undefined;
    evidence.recordAssertionEvidence("engine response reclaimed", collected ? "WeakRef → undefined" : "WeakRef still alive: window not exercised", collected);
    expect(collected).toBe(true);
  });
  await step("after: all three reads return the conversation, none say internal_error", async () => {
    evidence.recordAssertionEvidence("reads", `${statuses.join(" / ")}; body ${body.slice(0, 40)}`, statuses.every((s) => s === 200));
    expect(bodies.join()).not.toContain("internal_error");
  });
});
```

PR body line that names it (`open-a-pr`):

```markdown
## Evidence
`evals/specs/conversation-stays-readable.e2e.test.ts` — before: the read fails
with "Response body object should not be disturbed or locked"; after: all
three reads return the conversation and the reclaim witness is true.
```

Rules that make this parseable:

- Step names are `given / when / then / after:` (or `before: / after:` with
  screenshots). One clause each, the person's words, no function names.
- Every step records exactly one evidence line: the observed fact, with the
  numbers in it. The reviewer never opens the code to learn what happened.
- A **witness** step proves the risky condition actually occurred. If it did
  not, that step fails; a pass without the witness is not a proof.
- The quoted "before:" string in the PR body is the exact error the user or
  Sentry saw. CI shows it red on `dev` and green on the head; never narrate it.

Rules of thumb:

- At least three steps. Zero steps renders as "no claims declared".
- Every step has at least one `user.*` act or `user.see`. `probe.*` observes;
  it does not carry a step alone.
- One screenshot per visual beat. Non-visual work records `recordAssertionEvidence`
  with the command or response excerpt as the evidence text.
- For features, show the before state in the same world. Base-vs-head runs are
  expensive; a step that starts with the switch off is not.
- For permissions, sharing, or scopes, always include the negative persona.
- The world runs the code on the runtime it ships on. A spec that passes on
  the wrong runtime proves nothing (`run-tests` → Match the runtime).
- Prefer `seed.appWeb` (headless Chrome, real app). Use `seed.desktop` only for
  a native capability a browser cannot show, and say why in `nativeReason`.
- No `seed.evalIn` / `probe.eval` in new specs. If you need one, comment why.

## Use the testkit channels

Import `spec` (and `expect`) from `@openwork/testkit`; bind the world:

```ts
const test = spec.world(myWorld, {
  resources: { surfaces: ["appWeb"], services: ["den"] },
});
```

| Channel | Use it for |
| --- | --- |
| `seed` | Arrange the world: Den, orgs, members, workspaces, sessions, mocks, faults. Only `seed` writes state. All `seed.*` goes in the world, before the first act. |
| `user` | Act as the person: `click`, `type`, `press`, `reload`, `see`, `notSee`, `looks`, `screenshot`. Trusted CDP input; no JS evaluation. |
| `agent` | Drive the product's automation rail (`window.__openworkControl`): sends, session actions. |
| `probe` | Observe without changing state: `text`, `hash`, `storage`, `api` (GET), `dom`, `eventually`. |
| `step` | Name a claim. Nests. A failed step is recorded and rethrown; later steps show `not-reached`. |

Well-known targets: `"composer"` for the editor; otherwise role, label, text,
placeholder, or test id. Bound every wait; declare external requirements in
`needs()` so a missing dependency skips loudly.

## Claims and witnesses

- Every claim is machine-checkable with an observable assertion and its
  negative half: what must not happen to another identity, account, or state.
- Prose is never proof. Screenshots explain an assertion; they cannot replace it.
- Describe product behaviour, not incidental layout.
- If product and claim diverge, change one explicitly; never bend the claim.
- Never smuggle the answer into the prompt: assert the user-facing request
  carries no connector or resource IDs.
- Use `mcpMock()` witnesses under `evals/packages/labs/src/`; never call real
  providers. Witnesses are deterministic, identity-scoped, and queryable.

## Evidence contract

- Evidence is ambient: `user.screenshot()` records an artifact, `user.looks()`
  records a visual validation (judged later; pending until then),
  `recordAssertionEvidence()` records a witness assertion. Never create or
  pass recorder handles.
- Run it once before pushing and read your own record:

  ```sh
  pnpm evals:e2e <slug> --local
  ls evals/results/test-runs/<latest>/   # index.html, test-run.json, NN-*.png
  ```

  If the screenshots would not convince you, they will not convince the reviewer.
  Read the captions in `index.html` top to bottom: they should tell the
  before → after story on their own.
- In CI the spec runs on `PR change proof`, one job per spec; the trusted
  publisher aggregates every changed spec's records into one report. Failed,
  skipped, and cancelled runs stay visible as such; nothing substitutes for them.
