# voiceover-first-dx — Shipping a feature without writing a PRD

The demo of demo-driven development itself: the voice-over is written and
approved before any code, the build happens on a fresh worktree, agents build
until the full flow holds, and the proof lands on the PR. One paragraph per
frame; the flow loads its narration from this file, so this script is the spec
the code is held to.

1. This is a feature request. Normally this is where I'd write a PRD. Instead, I run the voiceover command and describe the feature in a sentence.

2. The agent writes back the demo script — the narration I'd record if the feature already existed. We iterate on words, not code. A dozen sentences. That's the whole spec.

3. I approve it, and the script lands in the repo as a file. From this point on, this file is what the code gets held to.

4. The build starts clean: the agent moves to a fresh worktree and branch, so the demo is built and proven in isolation and my checkout stays untouched.

5. The agent scaffolds a proof step per paragraph and goes to work: re-enacting the demo, fixing and re-running until every frame holds. If the flow's narration ever drifts from the approved script, the run fails.

6. The PR opens with the fraimz on it: my script, frame by frame, each line backed by a passing assertion. I review the demo, not the diff.

7. And the check is binding — a red demo means a failing run, and a failing run blocks the merge. The voice-over went in as the spec and came out as the proof.
