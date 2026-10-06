---
name: fix-design-notes
description: Design review check is neutral, design notes on a PR, "worth fixing", layout.split-row, OW-LIST, a reviewer says the UI looks off. Use to read what the design review found on a PR's screenshots, fix it in code, and prove the note is gone.
---

# Skill: Fix design notes

Every PR that records evidence screenshots gets an advisory **Design review**
check. It never blocks a merge, but a note marked *Worth fixing* is a defect a
careful designer would send back. Fix it, or say in the PR why the screen is
right.

## Read the notes

```bash
gh pr checks <pr>                                    # "Design review  neutral" = there are notes
sha=$(gh pr view <pr> --json headRefOid --jq .headRefOid)
gh api "repos/{owner}/{repo}/commits/$sha/check-runs?check_name=Design%20review" \
  --jq '.check_runs[0].output.text'
```

Each note gives:

| Field | Use it to |
| --- | --- |
| rule | `layout.*` was measured from the DOM (exact). `S2`, `V2`… are DESIGN.md; `OW-*` are the OpenWork Design rules in `evals/design-review/rubric.md` (judged from pixels; may vary run to run) |
| Screenshot | the spec step that took it, and the spec file |
| Where in the code | grep for the hook (`[data-library-row="…"]` → `data-library-row`) or the class list to find the component |
| Reproduce | the command that re-records the screenshots and reviews them locally |

The JSON block at the end of the check has the same notes for scripts.

## Reproduce, fix, verify

1. Run the note's reproduce command. Read `--json` output, not prose:
   `pnpm evals:e2e <slug> --local && pnpm --dir evals design:review -- --test-run latest --json`
   (judged notes need `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`; measured ones do not).
2. Find the component from the hook or class list. Read DESIGN.md and the rule
   in `evals/design-review/rubric.md` before changing anything: the fix follows
   the team's pattern, not the note's wording.
3. Fix it in the product code, never in the spec or the rubric.
4. Re-run the same command. The note must be gone and no new *Worth fixing*
   note may appear. Look at the screenshot yourself: a passing rule is not a
   good screen.
5. Push. CI re-runs the review; the check turns green (`No design notes`) or
   lists only what you decided to keep.

## When the screen is right

A judged note can be wrong, and a team decision can outrank a generic rule.
Leave the code, and put one line in the PR body under Evidence:
`Design review: kept OW-LIST-HEADER on the Library; the columns are compared (see DESIGN.md S2).`
Do not edit the rubric to silence a note in the same PR that triggers it.

## Rules

- Measured notes are facts about the layout; do not argue with the numbers.
- Never chase a judged note across runs: if it flips between runs, it is low
  confidence. Fix what you can see in the screenshot.
- Fix the shared component when the hook points at one (a row used by every
  list), not each screen.
