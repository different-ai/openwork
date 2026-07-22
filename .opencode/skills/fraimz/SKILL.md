---
name: fraimz
description: create a fraimz, make fraimz, prove it works, frame proof, PR proof, validate experience, e2e evidence, fraimz.html. The full fraimz loop — frame the claim, drive the real app via CDP, validate/repair, output fraimz.html. Use whenever a task ends with "please create a fraimz" or any change needs end-to-end proof.
---

# Skill: fraimz

**fraimz** is the canonical proof artifact: a single `fraimz.html`
(`evals/results/<run-id>/fraimz.html`) with one frame per step. Each frame binds
a **claim**, the **action** the end user took, the **assertion** that witnesses
the side effect, a **voiceover** that narrates the step, and a validated
**screenshot**. It is the thing a human looks at (and listens to) to understand,
at a glance, that an experience works.

This skill owns the prove-it loop. In the demo-driven journey (`voiceover`
skill: script → worktree → build → fraimz → PR) this is how the build is
verified; when orchestrating, the orchestrator drives this loop and delegates
code repairs to the executor.

Runner mode split: `pnpm evals` is automation mode (no voiceover requirements or
unnarrated-frame warnings). `pnpm fraimz` is the demo mode this skill describes:
voiceover drift is enforced and the artifact expects narrated frames.

## Every fraimz is a demo

A fraimz is never a bare test log. The flow declares which demo it is via
`kind` in `evals/flows/<id>.flow.mjs`:

- **`kind: "user-facing"`** — the end user is the protagonist; the frames walk
  a real journey through the UI. Default for any feature, fix, or UX change.
- **`kind: "internal"`** — for changes with no visible surface (perf, storage
  swaps, invariants, refactors): the frames demonstrate the internal claim in
  a way a reviewer can still follow. Terminal/tooling demos may set
  `requiresApp: false` to run without CDP; their frames carry claims,
  assertions, and `ctx.output` command output instead of screenshots (see
  `evals/flows/voiceover-first-dx.flow.mjs`).

If you cannot say which of the two your fraimz is, you have not framed the
experience yet.

## Voiceover first

The narration is the spec and it comes BEFORE the flow (and ideally before the
feature) — alignment and approval belong to the **`voiceover` skill** /
`/voiceover`. The approved script lives at `evals/voiceovers/<flow-id>.md`;
`pnpm fraimz scaffold <flow-id>` generates the flow from it, and the runner
**fails any flow whose narration drifts** from the approved file. Every
`ctx.prove` must carry a `voiceover` (one or two spoken-style sentences about
what the viewer sees, never implementation); frames without one are flagged in
the artifact — treat that as a failure for any flow you touch.

## When this applies

Make fraimz whenever a change can alter behavior observable outside the
process: filesystem, runtime DB, server endpoints, sessions, config,
provisioning, cloud sync, network. **Also for changes you expect to be inert**
(refactors, renames, dead-code removal): the job is then to prove the canonical
core flow is unchanged — open the app → write a message → get a response →
close → reopen with the session intact (`evals/flows/core-flow.flow.mjs`).
Pure docs/comments and types-only changes with no runtime path may skip — but
say so explicitly.

## The loop

Never report success from a click or a return value alone. Every meaningful
step is: **observe → act → observe → assert** — and repair before verdict.

1. **Frame the experience** as a one-line claim ("user can do X and sees Y")
   and pick the demo kind. State both back before proceeding.
2. **Get the script.** Approved voiceover at `evals/voiceovers/<id>.md`
   (via the `voiceover` skill), then `pnpm fraimz scaffold <id>` — or reuse an
   existing flow in `evals/flows/`.
3. **Code the flow.** The end user is the protagonist (driven via CDP);
   REST/DB/filesystem checks only witness the side effects. Every meaningful
   step uses `ctx.prove("claim", { voiceover, action, assert, screenshot })`.
4. **Drive it for real.** Launch the app (see below), then
   `pnpm fraimz --flow <id> --cdp-url <electron-cdp-url>`.
5. **Validate, repair, repeat.** If a frame does not support its claim (wrong
   route, error state, missing text, stale dialog, duplicate image, missing
   voiceover), fix the visible state or the code and rerun until every claim
   has a passing assertion, a narrated voiceover, and a valid screenshot.
6. **Verdict, on the PR.** The run writes `fraimz.html` + `report.md` /
   `report.json` to `evals/results/<run-id>/`; post it as a PR comment with
   `pnpm fraimz --flow <id> --pr [number]` (`--pr` alone targets the current
   branch's PR). Report `Passed` only when fraimz exists and every claim is
   backed by an observable assertion; otherwise `Incomplete` / `Failed`,
   stated honestly with repro steps.

## Driving the real app

Local Electron (fastest for a worktree you changed):

```bash
OPENWORK_ELECTRON_REMOTE_DEBUG_PORT=9826 pnpm dev   # & in background
pnpm fraimz --flow <id> --cdp-url http://127.0.0.1:9826
```

Daytona sandbox (isolated, VNC-visible; see `daytona-electron-test`):

```bash
bash .devcontainer/test-on-daytona.sh <branch> --artifacts-volume
pnpm fraimz --flow <id> --cdp-url <printed-electron-cdp-url>
```

The runner default-probes `:9825` (Daytona) then `:9823` (local `pnpm dev`);
pass `--cdp-url` for any other port. `pnpm evals --all --stack den` brings up
the cloud stack for env-gated cloud flows.

## Pitfalls (learned the hard way)

- **Target the right CDP page.** A sandbox can expose several targets; ad-hoc
  `browser_eval` defaults to the first — pass the OpenWork `target_id` when
  probing manually.
- **`__openworkControl` readiness.** Attaches after boot and resets on config
  reload: `ctx.waitFor("Boolean(window.__openworkControl)")` before driving,
  and re-wait after any "Reloading OpenCode config".
- **Flows must be idempotent.** A failed run can leave dialogs open or state
  dirty; start steps by restoring the state you need (e.g. Escape a stale
  dialog).
- **Don't race streamed/debounced UI.** Wait for the concrete artifact you
  assert on (the rendered row), not for a spinner to disappear.
- **Split reflow from measurement.** First a `waitFor` that returns true only
  once the DOM actually reflowed, then a separate `ctx.eval` to measure.
- **Screenshot validation takes arrays** (`requireText: ["foo"]`,
  `rejectText: [...]`, `hashIncludes: "/route"`). A screenshot with no
  validation metadata is a checkpoint, not proof.
- **Assert the regression, not nice-to-haves.** Prove what the change
  guarantees; don't fail the run on a cosmetic extra the fix never promised.
- **Eval-only seed affordances are fine** behind `import.meta.env.DEV` on
  existing `eval.*` control actions; keep them out of production paths and say
  so.

## ctx.* helpers (the flow API)

`ctx.eval`, `ctx.waitFor`, `ctx.waitForText`, `ctx.clickText`, `ctx.fill`,
`ctx.navigateHash`, `ctx.control(actionId, args)`, `ctx.expectText`,
`ctx.expectNoText`, `ctx.expectHashIncludes`, `ctx.assert`,
`ctx.screenshot(name, { claim, voiceover, requireText, rejectText, hashIncludes })`,
`ctx.output(name, text)`, and the headline
`ctx.prove("claim", { voiceover, action, assert, screenshot })`.
Reference flow: `evals/flows/session-search-grouped.flow.mjs`.

## Source of truth

- `evals/README.md` — runner, flags, conventions, full `ctx.*` reference.
- `evals/flows/` — existing coded flows to reuse or pattern-match.
- `evals/voiceovers/` + `evals/runner/voiceover.mjs` — approved scripts,
  parser, drift check, scaffolder; the `voiceover` skill owns the journey
  around this loop.
- `daytona-electron-test` (sandbox launch), `daytona-flow-validator`
  (Daytona-native windows/xdotool), `daytona-recording-artifacts` (video).
