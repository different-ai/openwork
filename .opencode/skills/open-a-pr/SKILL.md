---
name: open-a-pr
description: Open a PR, write or rewrite a PR description, "the PR body is too long", or check whether a PR description is readable. Use whenever a PR is created or its body is edited.
---

# Skill: Open a PR

A PR body is read in thirty seconds, before the diff. It answers four
questions and stops. Everything else lives in the commit messages, the spec,
and the report CI posts.

## The shape

`.github/pull_request_template.md`. Fill every heading; add none. Under ~200
words total.

```markdown
## What is this about?
One or two sentences, plain words: the surface and the change.

## What problem does it solve?
The pain a person felt or the risk we carried. Not the mechanism.

## What was the situation before?
What the person saw or could not do. Concrete enough to recognise in the
"before" screenshot.

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

CI runs every spec the PR changes on the PR head and posts one sticky
`<!-- test-evidence -->` comment linking the report. You never run the
publisher or attach screenshots by hand. The body names the spec and says
what the reader will see; it does not copy verdicts, SHAs, screenshots or
links, which go stale.

```markdown
## Evidence
`evals/specs/browser-tabs-owned-by-thread.e2e.test.ts` — before: the toolbar
shows Suspend; after: it does not, and a page still opens and can be used.
```

- The `before:` here and "What was the situation before?" are the same
  moment. If they disagree, fix one.
- No spec changed? Say why in one line: `No E2E; unit-tested` or
  `node --test .github/scripts/pr-proof.test.mjs — 6 passed`. If no evidence
  comment appears, that is why; do not run a spec locally and paste its output.
- Red evidence needs no sentence in the body: CI's comment says Failed on
  that SHA and flips on its own when the head goes green. Fix the spec or the
  code; do not narrate the verdict.
- Evidence binds to a commit. After a rebase or cherry-pick, wait for CI to
  rerun on the new head; do not cite the old comment.
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
