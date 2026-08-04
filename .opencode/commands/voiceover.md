---
description: Start a feature the demo-driven way — approve the voice-over (instead of a PRD), build on a fresh worktree, ship a PR with the proof on it
---

You are starting **voiceover-first development**: the demo voice-over is the
spec — the narration the user would record over a demo if the feature had
already shipped (instead of a PRD). **No code until the script is approved.**

Arguments: `$ARGUMENTS` — the feature, in a sentence. If empty, ask for one.

Load the **`voiceover` skill** and follow its journey end to end:

1. Draft the demo script — one numbered paragraph per frame, spoken style,
   the end user as protagonist. If a frame is hard to narrate, the feature is
   wrong: say so.
2. Iterate on the words with the user until they would actually record it.
3. On approval, start clean: create a fresh worktree + branch
   (`git worktree add ../_worktrees/openwork-<slug> -b feat/<slug> origin/dev`),
   then translate each approved paragraph directly into claims, actions, and
   assertions in `evals/specs/<slug>.slow.test.ts`. Import `test` from
   `@openwork/testkit`; evidence is ambient and has no roll handle.
4. Build until the demo holds: delegate coding when orchestrating, use
   `write-a-spec` → `run-tests`, and load `diagnose-a-red-run` for failures.
5. Ship: push the branch, open the PR (`gh pr create --base dev`), then use
   `publish-evidence` to publish the existing testkit evidence tape.

Do not write feature or spec code before the user has approved the script.
