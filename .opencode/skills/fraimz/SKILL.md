---
name: fraimz
description: create a fraimz, make fraimz, prove it works, frame proof, PR proof, validate experience, e2e evidence, fraimz.html. The full fraimz loop — frame the claim, drive the real app via CDP, validate/repair, output fraimz.html. Use whenever a task ends with "please create a fraimz" or any change needs end-to-end proof.
---

# Skill: fraimz

**fraimz** is the canonical proof artifact: a single `fraimz.html`
(`evals/results/<run-id>/fraimz.html`) with one frame per step. Each frame binds
a **claim**, the **action** the end user took, the **assertion** that witnesses
the side effect, and a validated **screenshot**. It is the atomic thing a human
looks at to understand, at a glance, that an experience works.

This skill owns the whole loop. Trigger phrases: "create a fraimz", "make
fraimz", "prove it works", "frame proof", "PR proof". The `/fraimz` command runs
the same loop.

## When this applies

Make fraimz whenever a change can alter behavior observable outside the process:
filesystem, SQLite/runtime DB, server endpoints, sessions, config, provisioning,
cloud sync, or network. **This also applies to changes you expect to be inert** —
refactors, storage swaps, renames, dead-code removal: the fraimz job is then to
prove the canonical core flow is unchanged. Pure docs/comments and types-only
changes with no runtime path may skip — but say so explicitly.

## The loop (never report success from a click or a return value alone)

1. **Frame the experience** as a one-line claim ("user can do X and sees Y").
   State it back before proceeding.
2. **Express it as a flow.** Reuse or add a coded flow in
   `evals/flows/<id>.flow.mjs`. The end user is the protagonist (driven via CDP).
   REST/DB/filesystem checks are *only* how you witness the expected side
   effects — never the thing being tested. Every meaningful step must use
   `ctx.prove("claim", { action, assert, screenshot })`.
3. **Drive it for real.** Launch the app (Daytona preferred, local Electron
   fallback) and run `pnpm fraimz --flow <id> --cdp-url <electron-cdp-url>`.
   Observe → act → observe → assert.
4. **Validate, repair, repeat.** If a frame does not support its claim (wrong
   route, error state, missing text, stale dialog, duplicate image), fix the
   visible state or the code and rerun until every claim has a passing assertion
   and a valid screenshot.
5. **Output fraimz + verdict.** The run writes `fraimz.html` plus
   `report.md` / `report.json` to `evals/results/<run-id>/`. Report the path to
   `fraimz.html` as the headline deliverable. Report `Passed` only when fraimz
   exists and every claim is backed by an observable assertion; otherwise
   `Incomplete` / `Failed`, stated honestly with repro steps.

## The canonical core flow

When a change is expected to be inert, re-run the core flow —
**open the app → write a message → get a response → close → reopen and confirm
the session survived** (`evals/flows/core-flow.flow.mjs`). If it stays green, the
inertness claim is backed by evidence.

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

## ctx.* helpers (the flow API)

`ctx.eval`, `ctx.waitFor`, `ctx.waitForText`, `ctx.clickText`, `ctx.fill`,
`ctx.navigateHash`, `ctx.control(actionId, args)`, `ctx.expectText`,
`ctx.expectNoText`, `ctx.expectHashIncludes`, `ctx.assert`,
`ctx.screenshot(name, { claim, requireText, rejectText, hashIncludes })`, and
the headline `ctx.prove("claim", { action, assert, screenshot })`.

## Source of truth

Keep this skill as the loop. The deeper mechanics live in:

- `evals/README.md` — runner, flags, conventions, full `ctx.*` reference.
- `evals/flows/` — existing coded flows to reuse or pattern-match.
- Skills: `run-evals` (launch + run), `daytona-flow-validator` (observe → act →
  assert → repair → verdict), `daytona-electron-test`,
  `daytona-recording-artifacts` (optional video).
