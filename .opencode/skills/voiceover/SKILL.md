---
name: voiceover
description: write the voice-over, demo script first, voiceover instead of PRD, voiceover-first development, align on the demo, script the demo, ship a feature demo-first. The whole demo-driven journey — approve the narration BEFORE any code, then build on a fresh worktree until the demo holds and open the PR with the proof on it. Use when a feature request arrives, or when the user runs /voiceover.
---

# Skill: voiceover

The voice-over is the spec. Instead of a PRD, a feature starts as the demo
narration the user would record if the feature had already shipped. This skill
owns the whole journey: **script → worktree → testkit spec → build → PR.**

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

## Phase 2 — Start clean and encode the demo

On approval, set up an isolated workspace so the user's checkout stays
untouched:

```bash
git fetch origin dev
git worktree add ../_worktrees/openwork-<slug> -b feat/<slug> origin/dev
```

Then, inside the worktree:

4. **Translate the approved narration directly into a spec.** Create
   `evals/specs/<slug>.slow.test.ts`, import `test` from `@openwork/testkit`,
   and encode each paragraph as user action, observable assertion, and evidence
   claim. Do not create a separate narration artifact. Evidence is ambient;
   never create, pass, or manage a roll handle.

## Phase 3 — Build until the demo holds

5. **Build the feature.** The orchestrator decomposes the work and delegates
   coding to the `executor` subagent. Follow `write-a-spec` → `run-tests`, load
   `diagnose-a-red-run` when the spec fails, and repair until every approved
   claim has an observable assertion in the ambient tape.

## Phase 4 — Ship (PR with the proof on it)

6. **Open the PR and publish the existing proof.** From the worktree:

```bash
git push -u origin feat/<slug>
gh pr create --base dev --fill
```

Then load `publish-evidence`. `pnpm fraimz:publish` remains the compatibility
command for publishing the completed testkit evidence tape; it does not run
tests. Custom screenshots or video may supplement the tape, never replace its
verdict evidence.

## Script format

```markdown
# <feature> — <one-line claim>

Optional context prose (not narrated).

1. First frame narration, one or two spoken sentences.

2. Second frame narration.
```

Keep each numbered paragraph to one or two sentences a human could speak over
the screen while it shows exactly that state. The approved conversation is
translated directly into the spec; it is not written to a separate file.

## Source of truth

- `write-a-spec` — authoring the `@openwork/testkit` spec.
- `run-tests` and `diagnose-a-red-run` — execution and repair.
- `publish-evidence` — publishing an existing ambient evidence tape.
