---
name: open-a-pr
description: Open a PR, write or rewrite a PR description, "the PR body is too long", or check whether a PR description is readable. Use whenever a PR is created or its body is edited.
---

# Open a PR

Apply **Thirty-Second Reader** and **Honest Verdict**. Everything beyond the body lives in commits, the spec and CI's report.

1. Fill every heading of `.github/pull_request_template.md`, add none, stay under ~250 words. The first three sections are plain words about what a person saw and felt. Paths, tools, routes and flags go only under "How is this implemented?". "What else changed?" lists every drive-by change, one bullet each, or `none`.
2. Release note: one sentence in product words about what a user can now do or no longer hits ("Connecting an account in chat no longer gets stuck on 'Checking connection request…'"). It feeds the changelog (`scripts/release/collect-release-prs.mjs`). Write `none` for CI, tests, tooling or invisible refactors. Anything that removes or changes what users rely on always gets a note.
3. Evidence: name the spec and its before and after in one line. The `before:` matches "What was the situation before?".

   ```markdown
   `evals/specs/browser-tabs-owned-by-thread.e2e.test.ts`: before, the toolbar shows Suspend; after, it does not, and a page still opens and can be used.
   ```

   - CI runs changed specs on the head and posts one sticky `<!-- test-evidence -->` comment. Never paste verdicts, SHAs, screenshots or links; never run the publisher by hand.
   - No spec changed: say why in one line (`No E2E; typecheck and build only`).
   - Red evidence needs no sentence. Fix the code or spec; CI flips the comment.
   - After a rebase, wait for CI on the new head.
   - UI changes end with `Design: P3, S4, C6` (DESIGN.md rule ids).
4. Leave out: root-cause narrative, suite counts, image digests, worktree or credential notes, other PRs' failures, Risk/Rollback/Out-of-scope boilerplate.
5. Title: conventional commit, imperative, under 70 characters.

```bash
gh pr create --base dev --title "<type>(<scope>): <change>" --body-file /tmp/pr-body.md
gh pr edit <n> --body-file /tmp/pr-body.md
```

Read the file as the reviewer would before sending. If a section makes you scroll, cut it.
