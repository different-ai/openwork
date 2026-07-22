---
name: voiceover
description: write the voice-over, demo script first, voiceover instead of PRD, voiceover-first development, align on the demo, script the demo, ship a feature demo-first. The whole demo-driven journey — approve the narration BEFORE any code, then build on a fresh worktree until the demo holds and open the PR with the proof on it. Use when a feature request arrives, or when the user runs /voiceover.
---

# Skill: voiceover

The voice-over is the spec. Instead of a PRD, a feature starts as the demo
narration the user would record if the feature had already shipped. This skill
owns the whole journey: **script → worktree → build → fraimz → PR.**

**The contract: no code until the script is approved.**

## Phase 1 — Align on words (no code)

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

## Phase 2 — Start clean (fresh worktree)

On approval, set up an isolated workspace so the user's checkout stays
untouched:

```bash
git fetch origin dev
git worktree add ../_worktrees/openwork-<flow-id> -b feat/<flow-id> origin/dev
```

Then, inside the worktree:

4. **Land the script** at `evals/voiceovers/<flow-id>.md`: a title, optional
   context prose, then the numbered frame paragraphs. From this point the file
   is what the code gets held to — the runner fails any flow whose narration
   drifts from it.
5. **Scaffold the flow.** `pnpm fraimz scaffold <flow-id>` generates
   `evals/flows/<flow-id>.flow.mjs` with one `ctx.prove` stub per paragraph,
   narration pre-wired via `loadVoiceoverParagraphs`. Do not renumber or
   reword paragraphs after this without re-approval.

## Phase 3 — Build until the demo holds

6. **Build the feature.** The orchestrator decomposes the work and delegates
   the coding to the `executor` subagent; the fraimz loop (see the `fraimz`
   skill) is how the orchestrator verifies each round — drive the demo
   against the real app, repair, and re-run until every frame passes.

## Phase 4 — Ship (PR with the proof on it)

7. **Open the PR and post the proof.** From the worktree:

```bash
git push -u origin feat/<flow-id>
gh pr create --base dev --fill
pnpm fraimz --flow <flow-id> --pr   # posts the frame-by-frame proof as a PR comment
```

The PR review is the demo review: verdict, claims, voiceovers, and assertions,
frame by frame.

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
  workflow demoing itself, worktree and PR included).
- The `fraimz` skill — the validate/repair/verdict loop inside Phase 3.
