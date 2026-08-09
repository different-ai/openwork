# Skill: release

Cut an OpenWork release. The "Release App" workflow
(`.github/workflows/release-macos-aarch64.yml`, triggered by a `v*` tag push or
dispatch) builds, signs, and publishes the desktop app assets on the GitHub
release. Full runbook: `docs/RELEASING.md`.

A release is **done when the run is green and the GitHub release is published**
(not a draft) — never when the tag is pushed.

---

## Choose a path

- **PR-first (default)**: land the bump on `dev` through a reviewed PR, then
  tag the merge commit. No tag/dev divergence; release waits on review.
- **Tag-first (expedited, admins only)**: `pnpm release:prepare` on a branch
  off `dev`, push the tag (the `v*` tag ruleset grants admins bypass), and
  backfill the bump into `dev` through a PR afterwards. Releases immediately;
  `dev` catches up through review. Use when a release must go out now.

Either way, **never push `dev` directly, force-push it, or bypass its branch
rules** — `dev` requires: at least one approval; approval of the latest push
by someone other than the pusher; conversations resolved; squash/rebase merge
only (the protected-branch commit stays GitHub-signed and linear).

Toolchain: pnpm must match the root `packageManager` pin —
`release:prepare` enforces this (a mismatched pnpm silently rewrites
`pnpm-lock.yaml`).

---

## Bump

PR-first path:

```bash
pnpm bump:patch     # or bump:minor / bump:major / bump:set -- X.Y.Z
```

This updates `apps/app`, `apps/desktop`, `apps/server` package.json versions
and `ee/apps/den-api/src/generated/desktop-versions.ts` (den-api's
`PUBLISHED_DESKTOP_VERSIONS` — the install door redirects to
`v<PUBLISHED_DESKTOP_VERSIONS[0]>`). Revert incidental noise before
committing. Commit as `chore(release): vX.Y.Z`, open a PR against `dev`,
merge once branch-protection requirements are satisfied.

Tag-first path:

```bash
pnpm release:prepare:dry
pnpm release:prepare        # bump + lockfile + review + commit + lightweight tag
```

If `prepare` dies after committing, rerun it — it resumes at the tag step
instead of double-bumping.

---

## Tag and ship

PR-first — tag the merge commit on dev:

```bash
git fetch origin dev
git tag vX.Y.Z origin/dev
git push origin vX.Y.Z
```

Tag-first — `pnpm release:ship` pushes the tag, then syncs `dev`: direct push
if allowed, otherwise it pushes `release/vX.Y.Z-dev-sync` and opens the
backfill PR. Get it approved by someone other than the pusher and merged.

---

## Watch

```bash
gh run list --repo different-ai/openwork --workflow "Release App" --limit 1
gh run watch <run-id> --repo different-ai/openwork --exit-status --interval 90
```

Publishing is gated on the electron matrix, electron assets, and npm publish.
`Publish AUR` (continue-on-error) and `Build + Push Daytona Snapshot` are
**non-blocking channels**: their failures don't stop the release — rerun the
workflow with the same tag once the channel recovers.

**If the run fails before the release is published:** land the fix on `dev`
via a normal protected-branch PR. Prefer a new patch tag if any release asset
may already have been consumed. Only delete/recreate a tag after verifying
the GitHub release is still draft-only:

```bash
git push --delete origin vX.Y.Z
git tag -f vX.Y.Z origin/dev
git push origin vX.Y.Z
```

**Rerun without retagging** (transient failure):

```bash
gh workflow run "Release App" --repo different-ai/openwork -f tag=vX.Y.Z
```

The release workflow may open an AUR packaging PR instead of pushing packaging
updates directly to `dev`. That is expected under branch protection. Get that
PR reviewed and squash/rebase-merged, then rerun the release workflow with the
same tag so the AUR publish step can observe that packaging is already up to
date.

When the workflow opens an AUR packaging PR, immediately inform the user with
the PR URL and the next required action. Then use the `question` tool to ask
exactly:

> Has the PR been merged?

Offer `Yes` and `No` options. Continue the release only when the user answers
`Yes`. If the user answers `No`, do not proceed; wait a few minutes, check the
PR merge status with `gh pr view <pr-url> --json merged,state`, and ask the
same question again. Repeat this sleep/check/question loop until the PR is
merged or the user explicitly stops the release.

---

## Verify

```bash
gh release view vX.Y.Z --repo different-ai/openwork --json assets --jq '.assets[].name'
```

Expect the app assets (`openwork-<platform>-X.Y.Z.*`, `latest*.yml` updater
manifests), including:

- `openwork-mac-arm64-X.Y.Z.dmg`
- `openwork-mac-x64-X.Y.Z.dmg`
- `openwork-win-x64-X.Y.Z.exe`

The desktop updater 404s on `latest*.yml` until the release is published —
that error in a running app during the build window is expected and
self-heals. Spot-check a download URL resolves (302 to release-assets CDN):

```bash
curl -sI "https://github.com/different-ai/openwork/releases/download/vX.Y.Z/openwork-mac-arm64-X.Y.Z.dmg" | head -2
```

Confirm `npm view openwork-server version` matches, and (tag-first path) the
backfill PR is merged.

---

## Notes

- Desktop installer fixes only reach users through a new release — the org
  install door (`/v1/install/:platform`) 302s to versioned assets.
- den deployments built from source pick up the new pin via
  `PUBLISHED_DESKTOP_VERSIONS[0]` (den-api `src/version.ts`); no env vars
  required.
- Native workspace deps must stay converged on one major across all apps —
  electron-builder rebuilds every copy it finds (see #3561/#3563 for the
  three-release outage this caused).
