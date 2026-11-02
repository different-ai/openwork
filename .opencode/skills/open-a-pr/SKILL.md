---
name: open-a-pr
description: Open a PR, write or rewrite a PR description, "the PR body is too long", or check whether a PR description is readable. Use whenever a PR is created or its body is edited.
---

# Skill: Open a PR

A PR body is read in thirty seconds, before the diff. It answers a few
questions and stops. Everything else lives in the commit messages, the spec,
and the report CI posts.

## The shape

`.github/pull_request_template.md`. Fill every heading; add none. Under ~250
words total.

```markdown
## What is this about?
One or two sentences, plain words: the surface and the change.

## What problem does it solve?
The pain a person felt or the risk we carried. Not the mechanism.

## What was the situation before?
What the person saw or could not do. Concrete enough to recognise in the
"before" screenshot.

## How is this implemented?
Two to five bullets for the reviewer: the main pieces that changed and how
they connect, so the diff reads in order. File paths, tool names, routes and
flags go here, not in the sections above.

## What else changed?
Anything in the diff that is not part of the main task: drive-by fixes,
refactors, renames, dependency bumps, test or tooling tweaks. One bullet
each, so the reviewer is not surprised by them. `none` if nothing.

## Release note
One sentence for people who use OpenWork, or `none`.

## Evidence
The spec that proves it, and in one line what its before → after shows.
```

The release note feeds the changelog agent directly
(`scripts/release/collect-release-prs.mjs`). Write what a user can now do or
no longer hits, in words they see in the product: "Connecting an account in
chat no longer gets stuck on 'Checking connection request…'." Write `none`
for CI, tests, review tooling, or refactors nobody will notice; the PR is
then left out of the changelog. A change that removes or alters something
users rely on always needs a note.

Title: conventional commit, imperative, under 70 characters.

## Evidence

PRs run only the quick check; specs do not run on PRs automatically. Run the
spec yourself (`run-tests`) before opening the PR, or have CI run the PR's
changed specs on its head and keep their records as artifacts:
`gh workflow run pr-proof.yml --ref <branch> -f pr=<number>`. After merge, the
dev push runs every proof it adds or changes and every core journey. The body names the spec and
says what the reader will see; it does not copy verdicts, SHAs, screenshots or
links, which go stale.

```markdown
## Evidence
`evals/specs/browser-tabs-owned-by-thread.e2e.test.ts` — before: the toolbar
shows Suspend; after: it does not, and a page still opens and can be used.
```

- The `before:` here and "What was the situation before?" are the same
  moment. If they disagree, fix one.
- No spec changed? Say why in one line, e.g. `No E2E; typecheck and build only`.
- Red evidence is fixed, not narrated: fix the spec or the code and rerun it.
- Evidence binds to a commit. After a rebase or cherry-pick, rerun the spec on
  the new head; do not cite the old run.
- UI changes: one trailing line `Design: P3, S4, C6` (DESIGN.md rule ids).

## Leave out

Root-cause narrative (commit message). Suite counts and CI matrices (the
Required verification check). Image digests, worktree setup, credential
notes (the spec's world). Other PRs' failures (an issue). Risk, Rollback,
Out-of-scope boilerplate. Caveats about your caveats.

## Do it

```bash
gh pr create --base dev --title "<type>(<scope>): <change>" --body-file /tmp/pr-body.md
gh pr edit <n> --body-file /tmp/pr-body.md
```

Write the file first and read it as the reviewer would. If a section makes
you scroll, cut it.
