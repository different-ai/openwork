---
description: Run the OpenWork release flow
---

You are running the OpenWork release flow in this repo.

Arguments: `$ARGUMENTS`
- If empty, default to a patch release.
- If set to `minor` or `major`, use that bump type.

Load and follow `.opencode/skills/release/SKILL.md`; `docs/RELEASING.md` is the
full runbook. Use the tag-first path unless the user explicitly requests
PR-first.

1. Fetch `origin/dev`. Work only from a clean checkout based on its current
   tip. If the user's checkout is dirty or `dev` is already checked out, create
   an isolated release worktree and leave the original checkout untouched.
2. Run `pnpm release:prepare:dry -- <bump>`, then
   `pnpm release:prepare -- <bump>`. In an isolated branch worktree, pass
   `--ci` only after independently confirming the branch is based on current
   `origin/dev` and the worktree is clean.
3. Run `pnpm release:ship`. A rejected direct push to protected `dev` is
   expected: `release:ship` must push a `release/vX.Y.Z-dev-sync` branch and
   open the backfill PR. Never bypass or force-push `dev`.
4. Watch the matching `Release App` run through completion. The release is not
   done until `Publish GitHub Release` succeeds and the release is public.
5. Get the version backfill PR approved and merged. If the workflow opens an
   AUR packaging PR, report its URL, wait for it to merge, then rerun Release
   App with the same tag as described by the release skill.
6. Verify the public release assets resolve, `npm view openwork-server version`
   matches the tag, and the latest relevant Daytona snapshot run is green.

Diagnose unexpected failures instead of treating Node runtime deprecation
warnings or the expected protected-branch rejection as release failures.
Report the tag, release URL, workflow verdict, merged backfill PR, npm version,
public asset check, and any non-blocking channel status.
