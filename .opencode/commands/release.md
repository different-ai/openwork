---
description: Prepare a one-review OpenWork release
---

Dispatch the protected composable release flow. Arguments: `$ARGUMENTS`.

- Accept only `patch`, `minor`, or `major`; default to `patch`.
- Run `pnpm release:prepare -- <bump> --watch`.
- Stop and report the setup blocker if the dedicated release GitHub App
  (`RELEASE_APP_ID`, `RELEASE_APP_PRIVATE_KEY`, exact `RELEASE_APP_LOGIN`, and
  `v*` tag-creation-only ruleset bypass) is not configured.
- Do not edit versions locally, create a tag, push `dev`, or bypass review.
- Report the Prepare Release run and its final release PR. That single PR already
  contains the version changes and AUR checksums from immutable staged artifacts.
- After the human approves it, auto-merge and the merge continuation perform the
  release. Do not ask whether it merged and do not manually rerun the whole release.
- If a post-merge stage fails, use the exact stage-only retry printed in the
  continuation summary.
