# Releasing OpenWork

The release flow is three root scripts wrapping `scripts/release/*.mjs`. A
release is **done when the `Release App` run is green and `Publish GitHub
Release` has flipped the release public** — not when the tag is pushed.

```bash
pnpm release:review          # sanity: versions aligned, opencode pin present
pnpm release:prepare:dry     # rehearse the bump (no mutation)
pnpm release:prepare         # bump + lockfile + review + commit + tag (patch)
pnpm release:ship            # push the tag (+ dev sync), print the run URL
pnpm release:ship:watch      # same, then tail the workflow run
```

## Prerequisites

- A clone whose `origin` **is** `different-ai/openwork` (not a fork), on a
  branch based on current `origin/dev`.
- **pnpm must match the root `packageManager` pin** — `prepare` enforces this
  and refuses to run otherwise. A mismatched pnpm silently rewrites
  `pnpm-lock.yaml` (older majors drop the `pnpm-workspace.yaml` overrides
  section). `corepack enable` or `npx -y pnpm@<pinned> release:prepare` both
  work.
- `gh` authenticated with push access; you must be a repo/org **admin** to
  push `v*` tags (see below).

## How protection actually works here

Two rulesets shape the flow:

- **`dev` is protected for everyone, including admins**: PR required, one
  approval, approval must come from someone other than the last pusher,
  signed commits, linear history, CodeQL. Direct pushes are rejected — this
  is why the flow releases **from the tag**, not from a `dev` push.
- **`v*` tags are admin-bypassable**: OrganizationAdmin and Repository admin
  can create release tags directly. The `Release App` workflow triggers on
  the tag push and builds from the tag ref.

Two valid orderings follow from that:

**PR-first (default)** — land the bump on `dev` through a reviewed PR
(`pnpm bump:patch`, commit `chore(release): vX.Y.Z`, PR, merge), then tag the
merge commit (`git tag vX.Y.Z origin/dev && git push origin vX.Y.Z`). No
tag/dev divergence; the release waits on review latency.

**Tag-first (expedited, admins only)** — when a release must go out now:

1. Branch from `origin/dev`, land any release-blocking fixes on `dev` first
   (through normal PRs).
2. `pnpm release:prepare` on the branch — creates the bump commit and the
   lightweight `vX.Y.Z` tag locally.
3. `pnpm release:ship` — pushes the tag (triggers the release), then tries to
   sync `dev`; when the direct push is rejected it pushes a
   `release/vX.Y.Z-dev-sync` branch and opens the **backfill PR** for you.
4. Get the backfill PR approved by a teammate (the pusher can't self-approve)
   and merged so `dev`'s version math is correct for the next release.

## Recovery and reruns

- **Rerun a tag without re-tagging** (e.g. after fixing an infra failure):

  ```bash
  gh workflow run "Release App" --repo different-ai/openwork -f tag=vX.Y.Z
  ```

- **`prepare` died after committing but before tagging**: just run it again —
  it detects an untagged bump commit at HEAD and resumes at the tag step
  instead of double-bumping.
- **A tagged version turned out to be defective before publish**: leave the
  release as a draft or delete it (`gh release delete vX.Y.Z`), fix forward,
  and cut the next patch. If the bad version reached npm, deprecate it:
  `npm deprecate openwork-server@X.Y.Z "<reason — use X.Y.Z+1>"`.

## What blocks publishing (and what doesn't)

`Publish GitHub Release` requires the electron matrix, electron assets, and
npm publish. It does **not** require:

- `Publish AUR` (`continue-on-error`) — aur.archlinux.org outages are not
  release failures.
- `Build + Push Daytona Snapshot` — snapshots are rebuildable afterwards by
  re-running the workflow with the same tag. Check it when Daytona sandboxes
  lag the released version.

## Verification checklist

```bash
gh run list --repo different-ai/openwork --workflow "Release App" --limit 3
gh release view vX.Y.Z --repo different-ai/openwork   # published, not draft
```

- Release is **not a draft** and marked Latest
- Asset count looks right (macOS + Linux + Windows + updater `latest*.yml`
  manifests — the desktop updater 404s until the manifests are published)
- `npm view openwork-server version` shows the new version
- Backfill PR merged (or open with a reviewer assigned)

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `fatal: no tag message?` at the tag step | global `tag.gpgsign=true` / `tag.forceSignAnnotated=true` | fixed — `prepare` now forces a lightweight tag; rerun it (it resumes) |
| Huge unexplained `pnpm-lock.yaml` diff | pnpm version ≠ `packageManager` pin | fixed — `prepare` refuses to run on mismatch |
| `pnpm release:*` starts a full workspace install | pnpm ≥ 10 `verify-deps-before-run` | fixed — `prepare` disables it for spawned commands |
| `git push origin dev` rejected | `dev` ruleset (PR-only, even for admins) | expected — `ship` opens the backfill PR instead |
| Desktop app shows updater 404 for the new version | tag exists but the release is still a draft mid-run | wait for `Publish GitHub Release`; self-heals |
| Release run red only on AUR / Daytona | external channel failure | release still publishes; rerun the workflow with the same tag when the channel recovers |
| All `electron-linux-*` fail compiling a native module | a raw-V8 native addon meeting new Electron headers under GCC | keep native deps converged on one N-API-based major across the whole workspace (see #3561/#3563) |

## History

This document encodes the 2026-08-05 releases (v0.18.15 validation cut,
v0.18.16 published): three releases had been red since the Electron 35→43
upgrade left `apps/server` on better-sqlite3 v12 while desktop moved to v13,
and electron-builder rebuilds every copy of a native module it finds in the
workspace. The fix converged the workspace on v13 (N-API) and taught
`opencode-db` to use `bun:sqlite` under Bun. Full context: #3561, #3563,
#3564.
