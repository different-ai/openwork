---
name: write-a-spec
description: Write or extend an E2E journey spec in evals/specs that proves a PR's change to a human reviewer. Use when a PR changes user-visible behaviour, when a reviewer asks "show me", or when the coverage decision says a journey is missing.
---

# Write a Spec

Every `evals/specs/**/*.e2e.test.ts` a PR adds or changes runs in CI on the PR head and is published as its proof (private report plus one PR comment).
Per **Prove It on the Real Thing**, this spec is the verdict. Per **Thirty-Second Reader**, write it for the person reading the report.

Siblings: `run-tests` (run and read the record), `preview-my-work` (sandbox link), `open-a-pr` (`## Evidence` line), `diagnose-a-red-run` (red proof), `record-a-demo` (attachments and recordings, not proof).

## Pick the lane first

CI picks the lane from the file name and tags alone. The lane decides the world you can build.

| If the spec… | Name / tag | CI lane |
| --- | --- | --- |
| runs in a browser or local world with no secrets (default) | `evals/specs/<journey>.e2e.test.ts` | PR change proof, unprotected |
| must boot the packaged desktop binary | `evals/specs/packaged-<journey>.e2e.test.ts` | packaged smoke runner |
| needs a reviewer to reopen the *running* browser at a screenshot | `{ tags: ["checkpoints"] }` in `test(...)` options | protected checkpoint lane on Freestyle |
| needs Windows and a published installer | the existing `windows-published-preview` spec only | Daytona Windows, protected |

Tag `checkpoints` only when a still image cannot show it: an open stream, a populated workspace, a state that takes minutes to reach. Say why in a comment beside the tag.
The lane uses a secret, so fork PRs cannot run it.
It saves the world as launched, the end state, every `user.checkpoint("caption")`, and every `step(..., { checkpoint: true })`. Plain `user.screenshot()` never saves one.
Each checkpoint is a VM snapshot. Capture only the one or two moments a reviewer would open.
Run locally: `pnpm evals:e2e <slug> --local --checkpoints` (needs `FREESTYLE_API_KEY`, per **Scope Secrets**).

## Do not write one when

- An existing journey covers it. Extend it. One spec per journey, not per PR. Bug fixes add a step to the journey they escaped from.
- The change is a pure function. Write a colocated unit test.
- You would import `../../apps|packages|ee`, read source, or spawn another runner. That is a unit test in disguise; the boundary ratchet rejects it.

No UI does not mean no spec. A server, proxy, or protocol bug gets a browser-less world (see `evals/specs/session-title-recovery.test.ts`) whose steps still read as one person's before and after.

## The proof shape

A proof answers: **who** can now do **what** they could not before, and who still cannot.
Each beat is one `step()` with a claim-sized name. Each visual beat ends in `user.screenshot()`.

```
persona  → the test title names a person: "an owner", "a teammate", "a member without access"
before   → what that person sees or cannot do today (features only)
action   → the person does the thing, through the UI
after    → what they now see; screenshot at that moment
boundary → who else is affected, and who is not
```

The report shows exactly four strings. Write each for the reviewer.

| Reviewer sees | Comes from | Rule |
| --- | --- | --- |
| Section heading | the `test("…")` title | names the persona and what they can now do |
| Caption under a screenshot | the `step("…")` the `user.screenshot()` ran inside | old state starts `before:`, new state `after:`; otherwise a plain claim |
| Caption + judgment on a `looks()` image | the first expectation in `user.looks([...])` | judged later; pending until then, so CI proof stays `Incomplete` |
| Assertion line | `recordAssertionEvidence(claim, evidence, ok)` | `claim` is the caption, `evidence` the text under it |

Each test is one section; checks collapse to "N of M checks passed" and open only on failure.
Screenshots form a numbered gallery, so captions must tell the story alone. One outside any `step()` is captioned "<title> artifact N".
A section with no `recordAssertionEvidence` shows as Incomplete. No "assert", selectors, or internal names in these strings.

```ts
test("an owner enables Code Mode and a teammate turns one chat into a shared Workflow", async ({ user, step }) => {
  await step("before: the teammate's agent has no script tool", …);        // screenshot
  await step("the owner enables Code Mode with one switch", …);             // screenshot
  await step("after: the teammate's request runs as one script", …);        // screenshot
  await step("the result is saved as a Workflow the team can open", …);    // screenshot
  await step("a member outside the team cannot see it", …);                // screenshot
});
```

The spec, report, and PR body tell one story in the same words. A bug fix with no screen keeps this shape, with one evidence line per step instead of a screenshot.

## Step rules

- Name steps `given / when / then / after:`, or `before: / after:` with screenshots. One clause, the person's words, no function names.
- Every step records exactly one evidence line: the observed fact, numbers included. The reviewer never opens the code.
- Add a **witness** step that proves the risky condition occurred (e.g. `WeakRef → undefined` after `gc()`). If it did not occur, that step fails.
- The quoted `before:` string in the PR body is the exact error the user or Sentry saw.
- At least three steps; zero renders as "no claims declared". Every step has at least one `user.*` act or `user.see`. `probe.*` observes; it never carries a step alone.
- One screenshot per visual beat. Non-visual work records the command or response excerpt as evidence.
- Show the before state in the same world. A step that starts with the switch off is cheap; base-vs-head runs are not.
- For permissions, sharing, or scopes, always include the negative persona.
- Run on the shipping runtime (`run-tests` → Match the runtime).
- Assert on user-visible moments. RPC responses compared in one block are a mechanism check, not a proof.

## Testkit

Channels (`seed`, `user`, `agent`, `probe`, `step`), world binding, `seed.appWeb` as the default surface, `nativeReason` for `seed.desktop`, and the raw-eval ratchet are in `evals/README.md` › Writing specs. Import only from `@openwork/testkit`. Target `"composer"` for the editor, otherwise role, label, text, placeholder or test id. Bound every wait. Declare external requirements in `needs()` so a missing dependency skips loudly.

- Use `seed.desktop` only for the titlebar and window controls, native menus and dialogs, `openwork://` links and the OAuth hand-off, the built-in browser pane, the updater, quit and relaunch, the desktop runtime's own settings, or packaged builds. Name it in `nativeReason`. A desktop world opens a window on whoever runs it locally.
- Signed in to a Den: `denForAppWeb` then `signedInAppWeb` (`evals/worlds/signed-in-app-web.ts`) replace `seed.desktop({ den, as })`.
- Extending a journey whose world uses `seed.desktop` for none of those reasons? Move it to `seed.appWeb` first. The browser app routes by path, not hash: use `go()` and `probe.hash()`, which handle both.

## Claims and witnesses

- Every claim has an observable assertion and its negative half: what must not happen to another identity, account, or state.
- Screenshots explain an assertion; they never replace it. Describe product behaviour, not incidental layout.
- Per **Fix the Product, Not the Gate**, never bend a claim to match the product.
- Never smuggle the answer into the prompt. Assert the user-facing request carries no connector or resource IDs.
- Use `mcpMock()` witnesses under `evals/packages/labs/src/`. Never call real providers. Witnesses are deterministic, identity-scoped, and queryable.

## Evidence contract

- Evidence is ambient. `user.screenshot()` records an artifact, `user.looks()` a pending visual validation, `recordAssertionEvidence()` a witness assertion. Never create or pass recorder handles.
- Run once before pushing and read your own record:

  ```sh
  pnpm evals:e2e <slug> --local
  ls evals/results/test-runs/<latest>/   # index.html, test-run.json, NN-*.png
  ```

  Read the captions in `index.html` top to bottom. They must tell the before and after story alone.
- Run the design review on the same record. Fix its `medium` notes or say in the PR why the screen is right (`evals/design-review/README.md`; on a PR use `fix-design-notes`):

  ```sh
  pnpm --dir evals design:review -- --test-run latest
  ```
- In CI each changed spec runs as one `PR change proof` job. The trusted publisher aggregates them into one report. Per **Honest Verdict**, failed, skipped, and cancelled runs stay visible as such.
