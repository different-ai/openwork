---
name: voiceover
description: write the voice-over, demo script first, voiceover instead of PRD, align on the demo, script the demo, demo-driven development intake. The alignment phase of demo-driven development — draft and approve the demo narration BEFORE any code, land it as evals/voiceovers/<id>.md, then scaffold the flow from it. Use when a feature request arrives, or when the user runs /voiceover.
---

# Skill: voiceover

The voice-over is the spec. Instead of a PRD, a feature starts as the demo
narration the user would record if the feature had already shipped. This skill
owns the alignment phase that precedes all implementation.

**The contract: no code until the script is approved.**

## The loop

1. **Take the feature in a sentence.** Ask only what you need to narrate a
   demo of it.
2. **Draft the script.** Write the voice-over end to end — one numbered
   paragraph per frame, 4–8 frames for most features. Spoken style, present
   tense, the end user as protagonist. Describe what the viewer sees and why
   it matters, never implementation. If a frame is hard to narrate, the
   feature (or the frame) is wrong — say so and reshape it.
3. **Iterate on words, not code.** State the script back and revise with the
   user until they would actually record it. This conversation is the review
   that used to happen on a PRD.
4. **Land the script.** Write it to `evals/voiceovers/<flow-id>.md`:
   a title, optional context prose, then the numbered frame paragraphs. From
   this point the file is what the code gets held to — the runner fails any
   flow whose narration drifts from it.
5. **Scaffold the flow.** `pnpm fraimz scaffold <flow-id>` generates
   `evals/flows/<flow-id>.flow.mjs` with one `ctx.prove` stub per paragraph,
   narration pre-wired via `loadVoiceoverParagraphs`. Do not renumber or
   reword paragraphs after this without re-approval.
6. **Hand off to the fraimz skill.** Build the feature and drive the demo
   (sandbox preferred, local Electron fallback) until every frame holds; the
   fraimz loop owns validate/repair/verdict and posting the proof on the PR
   (`pnpm fraimz --flow <id> --pr`).

## Script format

```markdown
# <flow-id> — <one-line claim>

Optional context prose (not narrated).

1. First frame narration, one or two spoken sentences.

2. Second frame narration.
```

Only numbered paragraphs become frames. Keep each to one or two sentences a
human could speak over the screen while it shows exactly that state.

## Source of truth

- `evals/runner/voiceover.mjs` — parser, drift check, scaffolder.
- `evals/voiceovers/voiceover-first-dx.md` — the reference script (this
  workflow demoing itself).
- The `fraimz` skill — everything after the script is approved.
