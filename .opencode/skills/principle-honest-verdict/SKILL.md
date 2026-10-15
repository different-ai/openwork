---
name: principle-honest-verdict
description: "Apply when reporting any test, check, or release result. Use exactly Passed, Incomplete, or Failed; a skip is never a pass; quote the command, SHA, exit code and counts; red evidence is never softened."
metadata:
  opencode/autoinvoke: "false"
  opencode/slash: "true"
---

# Honest Verdict

Report what ran, on which commit, and what it showed. Nothing more generous.

**Why:** A soft verdict ships bugs. "Mostly green" and "pre-existing" from memory are how regressions reach users.

- Three words only: `Passed` (every claim asserted), `Incomplete` (any skip, pending `looks()`, or missing witness), `Failed`.
- Write a skip as `skipped — needs: X`.
- Quote the exact command, commit SHA, exit code, passed/failed/skipped counts, and the first actionable failure verbatim.
- Evidence binds to a commit. After a rebase, cherry-pick, or new push, the old verdict is void; rerun.
- Never switch lanes, placements, or environments to turn red into green.
- Superseded evidence gets a new name and a note, never a silent swap.
