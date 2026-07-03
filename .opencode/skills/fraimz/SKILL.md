---
name: fraimz
description: create a fraimz, make fraimz, prove it works, frame proof, PR proof, validate experience, e2e evidence, fraimz.html. The full fraimz loop — frame the claim, drive the real app via CDP, validate/repair, output fraimz.html. Use whenever a task ends with "please create a fraimz" or any change needs end-to-end proof.
---

# Skill: fraimz

**fraimz** is the canonical proof artifact: a single `fraimz.html`
(`evals/results/<run-id>/fraimz.html`) with one frame per step. Each frame binds
a **claim**, the **action** the end user took, the **assertion** that witnesses
the side effect, a **voiceover** that narrates the step, and a validated
**screenshot**. It is the atomic thing a human looks at (and listens to) to
understand, at a glance, that an experience works.

This skill owns the whole loop. Trigger phrases: "create a fraimz", "make
fraimz", "prove it works", "frame proof", "PR proof". The `/fraimz` command runs
the same loop.

## Every fraimz is a demo

A fraimz is never a bare test log. It is always one of exactly two demos, and
the flow declares which via `kind` in `evals/flows/<id>.flow.mjs`:

- **`kind: "user-facing"`** — a flow demo. The end user is the protagonist; the
  frames walk a real journey through the UI ("discover the button, click it,
  see the result, land somewhere"). This is the default for any feature, fix,
  or UX change.
- **`kind: "internal"`** — an internal demo for changes with no visible surface:
  perf improvements, storage swaps, invariants, refactors. The frames
  demonstrate the internal claim (timings before/after, unchanged core flow,
  identical output) in a way a reviewer can still follow frame by frame.
  Internal demos of terminal/tooling experiences may set `requiresApp: false`
  to run without a CDP connection; their frames are claims + assertions +
  recorded command output (`ctx.output`) instead of screenshots (see
  `evals/flows/voiceover-first-dx.flow.mjs`).

If you cannot say which of the two your fraimz is, you have not framed the
experience yet — go back to step 1 of the loop.

## Voiceover first, always

Every frame carries a **voiceover**: one or two spoken-style sentences that
explain what the viewer is seeing and why it matters, as if narrating a demo
video. The runner renders it on each frame in `fraimz.html` with a play button
(Web Speech API), plus a "Play full voiceover" per flow.

Rules:

- **Write the voiceover script before coding the flow — ideally before the
  feature.** The script is the spec (the PRD replacement): align on it with
  the user via the **`voiceover` skill** / `/voiceover` command, then land it
  at `evals/voiceovers/<flow-id>.md` (numbered paragraphs = frames) and
  generate the flow from it with `pnpm fraimz scaffold <flow-id>`. Flows load
  their narration from the script (`loadVoiceoverParagraphs`), and the runner
  **fails any flow whose narration drifts** from the approved file (missing
  scripted frames or unapproved lines). If a step is hard to narrate, the
  step is wrong.
- Every `ctx.prove` must pass `voiceover`. Frames without one are flagged
  ("No voiceover for this frame") in the artifact — treat that flag as a
  failure for any flow you add or touch.
- Voiceovers describe **what the user sees** ("results are grouped, each label
  shows a count"), not implementation ("the memo re-computes").
- For `internal` demos the voiceover explains the invariant being witnessed
  ("same session list, half the queries").

## When this applies

Make fraimz whenever a change can alter behavior observable outside the process:
filesystem, SQLite/runtime DB, server endpoints, sessions, config, provisioning,
cloud sync, or network. **This also applies to changes you expect to be inert** —
refactors, storage swaps, renames, dead-code removal: the fraimz job is then to
prove the canonical core flow is unchanged. Pure docs/comments and types-only
changes with no runtime path may skip — but say so explicitly.

## The loop (never report success from a click or a return value alone)

1. **Frame the experience** as a one-line claim ("user can do X and sees Y")
   and pick the demo kind (`user-facing` or `internal`). State both back
   before proceeding.
2. **Write the voiceover script.** One narrated paragraph per planned frame,
   covering the whole demo end to end (see "Voiceover first, always").
3. **Express it as a flow.** Reuse or add a coded flow in
   `evals/flows/<id>.flow.mjs` with `kind` set. The end user is the protagonist
   (driven via CDP). REST/DB/filesystem checks are *only* how you witness the
   expected side effects — never the thing being tested. Every meaningful step
   must use `ctx.prove("claim", { voiceover, action, assert, screenshot })`,
   with `voiceover` taken from the script.
4. **Drive it for real.** Launch the app (Daytona preferred, local Electron
   fallback) and run `pnpm fraimz --flow <id> --cdp-url <electron-cdp-url>`.
   Observe → act → observe → assert.
5. **Validate, repair, repeat.** If a frame does not support its claim (wrong
   route, error state, missing text, stale dialog, duplicate image, missing
   voiceover), fix the visible state or the code and rerun until every claim
   has a passing assertion, a narrated voiceover, and a valid screenshot.
6. **Output fraimz + verdict — on the PR.** The run writes `fraimz.html` plus
   `report.md` / `report.json` to `evals/results/<run-id>/`. When a PR exists,
   post the proof on it: `pnpm fraimz --flow <id> --pr [number]` renders the
   frames (verdict, claims, voiceovers, assertions) as a PR comment via `gh`
   (`--pr` alone targets the current branch's PR). Report `Passed` only when
   fraimz exists and every claim is backed by an observable assertion;
   otherwise `Incomplete` / `Failed`, stated honestly with repro steps.

## The canonical core flow

When a change is expected to be inert, re-run the core flow —
**open the app → write a message → get a response → close → reopen and confirm
the session survived** (`evals/flows/core-flow.flow.mjs`). If it stays green, the
inertness claim is backed by evidence. This is the standard `internal` demo for
"nothing user-visible changed".

## Driving the real app

Preferred (Daytona): `bash .devcontainer/test-on-daytona.sh <branch>` then use
the printed Electron CDP URL. See the `run-evals` and `daytona-electron-test`
skills.

Local Electron fallback:

```bash
# from the worktree you changed
OPENWORK_ELECTRON_REMOTE_DEBUG_PORT=9826 pnpm dev   # & in background

# wait for the renderer, then run the flow against it
pnpm fraimz --flow <id> --cdp-url http://127.0.0.1:9826
```

The runner default-probes `:9825` (Daytona) then `:9823` (local `pnpm dev`).
Pass `--cdp-url` for any other port.

## Practical pitfalls (learned the hard way)

- **Target the right CDP frame.** A sandbox can expose multiple page targets
  (e.g. a `Google` page plus `OpenWork`). The runner uses `pickAppTarget`, but
  ad-hoc `browser_eval` defaults to the first target — pass the OpenWork
  `target_id` explicitly when probing manually.
- **`__openworkControl` readiness.** It attaches in the renderer after boot and
  resets on config reload. Always `ctx.waitFor("Boolean(window.__openworkControl)")`
  before driving; re-wait after any "Reloading OpenCode config".
- **Panels that auto-mount a browser tab** can steal focus from the artifact
  view. Re-select the artifact tab inside a `waitFor` and assert geometry in the
  same poll so the browser sync can't race you mid-measurement.
- **Reflow timing.** When you change layout/width to force a state, split it:
  first a `waitFor` that returns true only once the DOM has actually reflowed
  (e.g. `row.getBoundingClientRect().width <= 380`), then a separate
  `ctx.eval(MEASURE)` for the measurement.
- **Assert the regression, not nice-to-haves.** Prove what the change
  guarantees (e.g. "title truncates and does not overlap the buttons"); don't
  fail the run on a cosmetic extra the fix never promised.
- **Eval-only seed affordances are fine.** Adding a dev-only
  (`import.meta.env.DEV`) arg to an existing `eval.*` control action to make a
  state reproducible is acceptable; keep it out of production paths and say so.
- **`screenshot` validation takes arrays.** `requireText: ["foo"]`,
  `rejectText: [...]`, `hashIncludes: "/route"`. A screenshot with no validation
  metadata is a checkpoint, not proof.
- **Flows must be idempotent.** A failed previous run can leave dialogs open or
  state dirty; begin steps by restoring the state you need (e.g. Escape a stale
  dialog) instead of assuming a fresh app.
- **Don't race streamed results.** Debounced/async UI (deep search, scans)
  starts *after* your input lands; wait for the concrete artifact you assert on
  (the rendered row), not for a spinner to disappear — the spinner may not have
  appeared yet.

## ctx.* helpers (the flow API)

`ctx.eval`, `ctx.waitFor`, `ctx.waitForText`, `ctx.clickText`, `ctx.fill`,
`ctx.navigateHash`, `ctx.control(actionId, args)`, `ctx.expectText`,
`ctx.expectNoText`, `ctx.expectHashIncludes`, `ctx.assert`,
`ctx.screenshot(name, { claim, voiceover, requireText, rejectText, hashIncludes })`,
and the headline
`ctx.prove("claim", { voiceover, action, assert, screenshot })`.

Reference example (demo kind + per-frame voiceover):
`evals/flows/session-search-grouped.flow.mjs`.

## Source of truth

Keep this skill as the loop. The deeper mechanics live in:

- `evals/README.md` — runner, flags, conventions, full `ctx.*` reference.
- `evals/flows/` — existing coded flows to reuse or pattern-match.
- `evals/voiceovers/` + `evals/runner/voiceover.mjs` — approved scripts,
  parser, drift check, scaffolder; the `voiceover` skill owns the alignment
  phase before any code.
- Skills: `run-evals` (launch + run), `daytona-flow-validator` (observe → act →
  assert → repair → verdict), `daytona-electron-test`,
  `daytona-recording-artifacts` (optional video).
