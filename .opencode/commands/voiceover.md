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
   (`git worktree add ../_worktrees/openwork-<flow-id> -b feat/<flow-id> origin/dev`),
   land the script at `evals/voiceovers/<flow-id>.md` there, and scaffold the
   flow with `pnpm fraimz scaffold <flow-id>`.
4. Build until the demo holds: delegate the coding (executor subagent when
   orchestrating), and verify with the `fraimz` skill until every frame passes.
5. Ship: push the branch, open the PR (`gh pr create --base dev`), and post
   the proof on it with `pnpm fraimz --flow <flow-id> --pr`.

Do not write feature code, and do not scaffold, before the user has approved
the script.
