---
description: Run the OpenWork release flow
---

You are running the OpenWork release flow in this repo.

Arguments: `$ARGUMENTS`
- If empty, default to a patch release.
- If set to `minor` or `major`, use that bump type.

Load and follow `.opencode/skills/release/SKILL.md`; `docs/RELEASING.md` is the
full runbook. Use the Release Cut workflow path unless the user explicitly
requests PR-first or the workflow is unavailable.

1. Dispatch the cut and find its run:

   ```bash
   gh workflow run release-cut.yml --repo different-ai/openwork -f bump=<bump>
   gh run list --repo different-ai/openwork --workflow "Release Cut" --limit 1
   ```

   Watch it through completion; its summary reports the tag, the backfill PR,
   and the dispatched `Release App` run. If the cut fails on the tag push, the
   `v*` tag ruleset does not allow the Actions actor — report that the
   one-time bypass setup (or a `RELEASE_CUT_TOKEN` secret) is required and
   fall back to the local tag-first path from the release skill only if the
   user is an admin and asks for it.
2. Watch the matching `Release App` run through completion. The release is not
   done until `Publish GitHub Release` succeeds and the release is public.
3. Get the version backfill PR approved and merged. If the workflow opens an
   AUR packaging PR, report its URL, wait for it to merge, then rerun Release
   App with the same tag as described by the release skill.
4. Verify the public release assets resolve, `npm view openwork-server version`
   matches the tag, and the latest relevant Daytona snapshot run is green.

Diagnose unexpected failures instead of treating Node runtime deprecation
warnings or the expected protected-branch rejection as release failures.
Report the tag, release URL, workflow verdict, merged backfill PR, npm version,
public asset check, and any non-blocking channel status.
