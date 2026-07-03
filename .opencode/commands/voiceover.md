---
description: Start a feature the demo-driven way — align on the demo voice-over (instead of a PRD) before any code
---

You are starting the **voice-over alignment phase** of demo-driven development.
The voice-over is the spec: the narration the user would record over a demo if
the feature had already shipped. **No code until the script is approved.**

Arguments: `$ARGUMENTS` — the feature, in a sentence. If empty, ask for one.

Load the **`voiceover` skill** and follow its loop:

1. Draft the demo script end to end — one numbered paragraph per frame,
   spoken style, the end user as protagonist, what the viewer sees and why it
   matters. If a frame is hard to narrate, the feature is wrong: say so.
2. Iterate on the words with the user until they would actually record it.
3. On approval, land it at `evals/voiceovers/<flow-id>.md` and run
   `pnpm fraimz scaffold <flow-id>` to generate the flow stub (one `ctx.prove`
   per paragraph, narration wired to the script; the runner fails the flow if
   narration ever drifts from the file).
4. Hand off to the `fraimz` skill: build the feature and re-enact the demo
   until every frame holds, then put the proof on the PR with
   `pnpm fraimz --flow <flow-id> --pr`.

Do not write feature code, and do not scaffold, before the user has approved
the script.
