# Releasing OpenWork

A release is **done when the `Release App` run is green and `Publish GitHub
Release` has flipped the release public** — not when the tag is pushed.

## One-button path (default): Release Cut workflow

```bash
gh workflow run release-cut.yml --repo different-ai/openwork -f bump=patch
# rehearse without pushing anything:
gh workflow run release-cut.yml --repo different-ai/openwork -f bump=patch -f dry_run=true
```

`.github/workflows/release-cut.yml` runs `scripts/release/prepare.mjs --ci` on
current `dev` HEAD (bump + lockfile + strict review + commit + tag), pushes
the tag, opens the `release/vX.Y.Z-dev-sync` backfill PR, and dispatches
`Release App` for the tag. No local toolchain is involved; the only human
follow-up is merging the backfill PR.

One-time setup: the `v*` tag ruleset must allow the workflow to create tags —
add the GitHub Actions app as a bypass actor, or store an admin bot token as
the `RELEASE_CUT_TOKEN` repo secret (with the secret set, the tag push itself
triggers `Release App` and the explicit dispatch is skipped).

## Local path (fallback)

The local flow is three root scripts wrapping `scripts/release/*.mjs`:

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
  `npm deprecate openwork-server@X.Y.Z "<reason — use X.Y.Z+1>"`. If the
  release was published, follow
  [Rolling back a published release](#rolling-back-a-published-release).

## Rolling back a published release

Use this flow when a bad version is **published** and marked Latest.

### 1. Stop the bleed

Dry-run first, then execute:

```bash
pnpm release:rollback
pnpm release:rollback --bad vX.Y.Z --execute
```

Always pin `--bad` when executing: after a successful rollback the *good*
release is Latest, so a bare re-run would select it as bad.

By default, the script selects the current Latest release as bad and the
newest lower published stable release as last good. It re-points Latest,
demotes the bad release to prerelease, and prepends a warning to its notes.
Use `--bad vX.Y.Z --to vX.Y.Z` to override selection. This protects only
clients that have not updated yet.

### 2. Reissue for updated clients

Updaters refuse downgrades. Cut the next patch **from the last-good tag**, not
from `dev`, which still contains the bad code:

```bash
git worktree add <tmp> <to-tag>
cd <tmp>
pnpm release:prepare  # must bump to a version higher than the bad release
pnpm release:ship
```

Use the tag-first path (admins only). Review and merge the backfill PR per the
existing flow. The org install door pin (`ee/apps/den-api` generated
`PUBLISHED_DESKTOP_VERSIONS`) moves only with this reissue.

### 3. Deprecate npm

```bash
npm deprecate openwork-server@<bad-version> "rolled back — use <next>"
```

| Client state | Recovery |
| --- | --- |
| Not yet updated | Fixed by step 1 |
| Already updated | Fixed only by step 2 |

Revert the offending PR on `dev` through the normal reviewed-PR flow (or the
revert fast lane, when available). That cleanup is not in the critical path
of user recovery.

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
