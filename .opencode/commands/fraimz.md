---
description: Make fraimz for a flow — run the eval loop and output frame-by-frame proof (fraimz.html)
---

You are making **fraimz** for a change in this repo. fraimz is the canonical
human-readable proof artifact: a single `fraimz.html` with one frame per step —
each frame binds a **claim**, the **action** the end user took, the
**assertion** that witnesses the side effect, and a validated **screenshot**.
That HTML is the thing a human looks at to understand, at a glance, that the
experience works.

Arguments: `$ARGUMENTS`
- If it names an existing flow id (see `pnpm evals --list`), make fraimz for it.
- Otherwise treat it as the experience to prove and create a flow first.
- If empty, default to the canonical core flow (`core-flow`): open the app →
  write a message → get a response → close → reopen with the session intact.

Run the full loop, in order, and stop on any failure:

1. **Frame the experience** as a one-line claim ("user can do X and sees Y").
   State it back before proceeding.
2. **Create or pick the eval.** If an approved voice-over script exists at
   `evals/voiceovers/<id>.md` (see the `voiceover` skill / `/voiceover`),
   generate the flow from it: `pnpm fraimz scaffold <id>` — narration is wired
   to the script and the runner fails the flow if it drifts. Otherwise write
   one in `evals/flows/<id>.flow.mjs` using the `ctx.*` helpers (`clickText`,
   `fill`, `control`, `waitFor`, `expectText`, `prove`, `screenshot`). The end
   user is the protagonist (drive via CDP). REST/DB/filesystem checks are ONLY
   how you witness the expected side effects — never the thing being tested.
   Every meaningful step must use
   `ctx.prove("claim", { voiceover, action, assert, screenshot })`.
3. **Drive it for real.** Launch the app (Daytona preferred via
   `bash .devcontainer/test-on-daytona.sh`, local Electron `pnpm dev` as
   fallback), then run:
   `pnpm fraimz --flow <id> --cdp-url <electron-cdp-url>`
   Observe → act → observe → assert.
4. **Validate, repair, repeat.** If a frame does not support its claim (wrong
   route, error state, missing text, stale dialog, duplicate image), fix the
   visible state or the code and rerun until every claim has a passing
   assertion and a valid screenshot.
5. **Output fraimz — on the PR when one exists.** The run writes `fraimz.html`
   (frame proof) plus `report.md` / `report.json` to `evals/results/<run-id>/`.
   Report the path to `fraimz.html` as the headline deliverable, and post the
   proof as a PR comment with `pnpm fraimz --flow <id> --pr [number]`.
6. **Verdict.** `Passed` only when the proof exists and every claim is backed by
   an observable assertion in the frames. Otherwise report `Incomplete` or
   `Failed`, honestly, with repro steps. If the app could not run (no model,
   dead engine, no CDP), say so explicitly and give the exact commands to
   reproduce.

The loop and its pitfalls live in the **`fraimz` skill** (load it first); the
deeper mechanics live in `evals/README.md` and the `run-evals` /
`daytona-flow-validator` skills — use them as the source of truth.
