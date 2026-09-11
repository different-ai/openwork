# Releasing OpenWork

Releases are **pure GitHub Actions + GitHub Releases**: versions live in git
tags, every committed `package.json` holds the permanent `0.0.0-dev`
placeholder, and CI stamps the tag-derived version into the workspace at build
time. Cutting a release makes **zero commits to this repo**. A release is
**done when the `Release App` run is green and `Publish GitHub Release` has
flipped the release public** — not when the tag is created.

```bash
pnpm release:cut            # dispatch Release App with bump=patch
pnpm release:cut minor      # or major
pnpm release:cut --version 0.19.0
pnpm release:cut:watch      # dispatch, then tail the run
pnpm release:review         # sanity: placeholders intact, opencode pin present
```

## How a release works

1. `release:cut` dispatches `Release App` (or run it from the Actions tab).
2. The `resolve-release` job computes the next version from the highest stable
   `v*` tag (`scripts/release/versions.mjs`), creates the tag on `origin/dev`
   HEAD, and creates it via REST as the diff-warden app. The app's tag retriggers
   the workflow, but that duplicate run is skipped by an actor guard — the
   dispatch run *is* the release run.
3. `verify-release` checks the tag (`scripts/release/verify-tag.mjs`): strict
   stable `vX.Y.Z` format, and fresh tags must be strictly greater than every
   other stable tag. `release:review --strict` guards that the committed
   placeholders were not replaced with real versions.
4. Build jobs check out **the tag** and run
   `scripts/release/stamp-version.mjs`, which writes the version into
   `apps/{app,desktop,server}/package.json` in the CI workspace only. That is
   what electron-builder, `app.getVersion()`, the Vite renderer bundle, and
   the `openwork-server` npm publish all read.
5. `publish-release` flips the draft public once required assets exist. From
   that moment den-api serves the new version to orgs: it reads published
   releases from the GitHub Releases API at runtime
   (`ee/apps/den-api/src/desktop-releases.ts`) — prereleases and drafts are
   excluded, so a rollback demotion removes a version immediately.

## Prerequisites

- `gh` authenticated with permission to dispatch workflows.
- **One-time repo setting (done)**: the org-owned **diff-warden** GitHub App
  is a bypass actor on the `v*` tag ruleset; `resolve-release` mints its
  token (`WARDEN_APP_ID` + `WARDEN_PRIVATE_KEY` in the `warden-clearance`
  environment) to create the tag ref via REST. The built-in GitHub Actions app cannot be a bypass actor —
  GitHub rejects it. Without the app token the run falls back to
  GITHUB_TOKEN and fails with instructions.
- Manual tag pushes (expedited path below) additionally require repo/org
  admin, as before.

## How protection actually works here

- **`dev` is protected for everyone, including admins**: PR required, one
  approval, approval from someone other than the last pusher, signed commits,
  linear history. The release never touches `dev` — nothing to backfill.
- **`v*` tags are creation-restricted**: admins and the GitHub Actions
  principal (for workflow-created tags) can create them.

Two entry paths:

**Dispatch (default)** — `pnpm release:cut`. The tag is created on
`origin/dev` HEAD, so the released code is always reviewed code.

**Tag-first (expedited, admins only)** — when a release must go out now from
a commit not yet on `dev`:

```bash
git tag vX.Y.Z <sha>
git push origin vX.Y.Z
```

The tag names exactly the code that ships (there is no bump commit). The
Expedited Release Audit workflow opens a post-hoc review issue whenever a
released tag's commit is not on `dev`; land the same changes on `dev` through
a normal reviewed PR and close the loop there.

## Recovery and reruns

- **Rerun an existing tag** (infra failure, replay AUR/Daytona):

  ```bash
  gh workflow run "Release App" --repo different-ai/openwork -f tag=vX.Y.Z
  ```

  Recovery runs skip tag creation and monotonicity. Sources are pinned to the
  tag; workflow-file fixes are picked up from `dev` automatically because the
  workflow definition runs from the dispatched ref.

- **A tagged version turned out defective before publish**: leave the release
  as a draft or delete it (`gh release delete vX.Y.Z`), fix forward on `dev`,
  and cut the next patch. If the bad version reached npm, deprecate it:
  `npm deprecate openwork-server@X.Y.Z "<reason — use X.Y.Z+1>"`.

## Rolling back a published release

Use this flow when a bad version is **published** and marked Latest.

### 1. Stop the bleed

Dry-run first, then execute:

```bash
pnpm release:rollback
pnpm release:rollback --bad vX.Y.Z --execute
```

Always pin `--bad` when executing: after a successful rollback the *good*
release is Latest, so a bare re-run would select it as bad. The script
re-points Latest, demotes the bad release to prerelease, and prepends a
warning to its notes. Demotion also removes the version from den-api's
published list at runtime (it excludes prereleases), so org installs and the
update gate stop offering it within the cache window.

### 2. Reissue for updated clients

Updaters refuse downgrades. Tag the **last-good commit** with a version higher
than the bad release — no commits, no worktree:

```bash
git tag vX.Y.Z+1 <last-good-tag>
git push origin vX.Y.Z+1
```

### 3. Deprecate npm

```bash
npm deprecate openwork-server@<bad-version> "rolled back — use <next>"
```

| Client state | Recovery |
| --- | --- |
| Not yet updated | Fixed by step 1 |
| Already updated | Fixed only by step 2 |

Revert the offending PR on `dev` through the normal reviewed-PR flow. That
cleanup is not in the critical path of user recovery.

## What blocks publishing (and what doesn't)

`Publish GitHub Release` requires the electron matrix, electron assets, and
npm publish. It does **not** require:

- `Publish AUR` (`continue-on-error`) — aur.archlinux.org outages are not
  release failures. AUR publishing renders the committed
  `packaging/aur` template (pkgver=0.0.0) with the real version + checksums
  in the CI workspace and pushes only to the AUR remote.
- `Build + Push Daytona Snapshot` — snapshots are rebuildable afterwards by
  re-running the workflow with the same tag.

## Verification checklist

```bash
gh run list --repo different-ai/openwork --workflow "Release App" --limit 3
gh release view vX.Y.Z --repo different-ai/openwork   # published, not draft
```

- Release is **not a draft** and marked Latest
- Asset count looks right (macOS + Linux + Windows + updater `latest*.yml`
  manifests — the desktop updater 404s until the manifests are published)
- `npm view openwork-server version` shows the new version
- `curl -s https://api.openworklabs.com/v1/app-version` lists the new version
  once den-api's cache refreshes (≤5 minutes)

## Where versions live now

| Question | Answer |
| --- | --- |
| What versions exist? | `git tag --list 'v*'` / GitHub Releases |
| What's the latest? | `gh release view --json tagName` |
| What commit is vX.Y.Z? | `git rev-parse vX.Y.Z` |
| What version is this checkout? | `git describe --tags` (package.json says `0.0.0-dev` on purpose) |
| Oldest supported desktop version? | `MIN_SUPPORTED_DESKTOP_VERSION` — committed policy in `scripts/release/generate-desktop-versions.mjs` |

`ee/apps/den-api/src/generated/desktop-versions.ts` is a cold-start/offline
fallback snapshot only; refresh it occasionally with
`node scripts/release/generate-desktop-versions.mjs --version <latest>`.

One file does carry a released version by design: the pull-only evaluation
stack `packaging/docker/docker-compose.eval.yml` pins den-api and den-web by
`<version>@<digest>`, and the docs download it by commit sha + checksum. After
`Publish EE Artifacts` pushes a stable tag's images, its `pin-eval-compose` job
opens an auto-approved, auto-merging PR to `dev` that rewrites those pins
(`scripts/release/pin-compose-images.mjs`), and `Compose pins drift`
(`node scripts/release/check-compose-pins.mjs`) fails when the pins lag the
highest stable tag. Like the changelog PR, that bot PR follows the release; it
is not part of cutting it.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Run fails pushing the tag | diff-warden app missing from the `v*` ruleset bypass list, or its secrets unset | re-add the app (Settings → Rules) / restore `WARDEN_APP_ID`+`WARDEN_PRIVATE_KEY`, or push the tag manually as an admin and rerun |
| `Tag vX.Y.Z already exists` on a fresh cut | version already released | rerun with `-f tag=vX.Y.Z` (recovery) or pick a higher version |
| `verify-release` fails monotonicity | manual tag lower than an existing release | choose a version above the current highest stable tag |
| `release:review` fails placeholder check | someone committed a real version into package.json | restore `0.0.0-dev` — CI stamps versions from the tag |
| Desktop app shows updater 404 for the new version | tag exists but the release is still a draft mid-run | wait for `Publish GitHub Release`; self-heals |
| Release run red only on AUR / Daytona | external channel failure | release still publishes; rerun with the same tag when the channel recovers |
| All `electron-linux-*` fail compiling a native module | a raw-V8 native addon meeting new Electron headers under GCC | keep native deps converged on one N-API-based major across the whole workspace (see #3561/#3563) |
| Windows legs fail in afterPack with `Missing staged MCP runtime package` | asar path-separator mismatch | fixed — `normalizeAsarEntryPath` in `electron-after-pack.cjs` |

## History

- **2026-08**: releases became commit-free (tags are the only version source;
  CI stamps the workspace; den-api reads published releases at runtime; AUR
  renders a committed template). Previously every release required a version
  bump commit, a dev backfill PR, and an AUR packaging PR.
- **2026-08-05** (v0.18.15/v0.18.16): three releases red since the Electron
  35→43 upgrade left `apps/server` on better-sqlite3 v12 while desktop moved
  to v13 — electron-builder rebuilds every copy of a native module it finds.
  Fixed by converging the workspace on v13 (N-API) and teaching `opencode-db`
  to use `bun:sqlite` under Bun. Full context: #3561, #3563, #3564.
