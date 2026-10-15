---
name: fix-design-notes
description: Design notes on a PR, "Design review (advisory)" in the evidence check, "worth fixing", layout.split-row, OW-LIST, a reviewer says the UI looks off. Use to read what the design review found on a PR's screenshots, fix it in code, and prove the note is gone.
---

# Fix design notes

PRs with evidence screenshots get an advisory design review inside the **Evidence preview** check. Notes never change the verdict, but *Worth fixing* is a defect a careful designer would send back. Fix it or say in the PR why the screen is right.

## Read

```bash
sha=$(gh pr view <pr> --json headRefOid --jq .headRefOid)
check() { gh api "repos/{owner}/{repo}/commits/$sha/check-runs?check_name=Evidence%20preview" --jq ".check_runs[0].output.$1"; }
check summary   # "Design review (advisory): 3 notes, 1 worth fixing." or "no notes."
check text      # notes, then the same notes as JSON
```

- `layout.*` rules are measured from the DOM. They are facts.
- `S2`, `V2`… are DESIGN.md; `OW-*` are in `evals/design-review/rubric.md`. These are judged from pixels and can flip between runs; a flipping note is low confidence.
- Each note names the screenshot's spec step, a code hook (`[data-library-row="…"]` → grep `data-library-row`) and a reproduce command.

## Fix

1. Reproduce: `pnpm evals:e2e <slug> --local && pnpm --dir evals design:review -- --test-run latest --json` (judged notes need `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`).
2. Read DESIGN.md and the rubric rule. Follow the team's pattern, not the note's wording.
3. Fix the product code, in the shared component when the hook points at one (**Fix the Product, Not the Gate**).
4. Rerun the same command. The note is gone, no new *Worth fixing* appears, and you looked at the screenshot yourself.
5. Push. The check summary should read `no notes.` or list only what you kept.

To keep a note, leave the code and add one line under Evidence: `Design review: kept OW-LIST-HEADER on the Library; the columns are compared (see DESIGN.md S2).`
