---
name: release
description: Cut an OpenWork release, release the app, publish a new version, rerun or recover a release tag, verify release assets. Tag-driven GitHub Actions release that makes zero commits to the repo.
---

# Skill: release

Cut an OpenWork release. The "Release App" workflow
(`.github/workflows/release-macos-aarch64.yml`) builds, signs, and publishes
the desktop app assets on the GitHub release. Full runbook:
`docs/RELEASING.md`.

**Versions live in git tags only.** Every committed `package.json` holds the
permanent `0.0.0-dev` placeholder; CI stamps the tag-derived version into the
workspace at build time (`scripts/release/stamp-version.mjs`). A release makes
**zero commits to this repo** — no bump commit, no backfill PR, no packaging
PR.

A release is **done when the run is green and the GitHub release is published**
(not a draft) — never when the tag is created.

---

## Cut a release (default path)

```bash
pnpm release:cut            # dispatches Release App with bump=patch
pnpm release:cut minor      # or major
pnpm release:cut --version 0.19.0
pnpm release:cut:watch      # same as release:cut, then tails the run
```

Equivalent by hand:

```bash
gh workflow run "Release App" --repo different-ai/openwork -f bump=patch
```

The run resolves the next version from existing `v*` tags, creates the tag on
`origin/dev` HEAD, verifies it (`scripts/release/verify-tag.mjs`: stable
format + strictly greater than every other stable tag), stamps the version
into the CI workspace, builds all 18 electron matrix legs, publishes npm +
Daytona + AUR, and flips the draft release public.

The tag ref is created via REST with the org-owned **diff-warden** app token
(a `v*` ruleset bypass actor; `WARDEN_APP_ID` + `WARDEN_PRIVATE_KEY` in the
`warden-clearance` environment). The app's tag retriggers the workflow; that duplicate run is skipped by an
actor guard. If the tag push is rejected, the run fails with instructions —
fix the ruleset bypass or fall back to a manual admin tag push.

## Tag-first (expedited, admins only)

To release a commit that is not yet reviewed onto `dev` (incident response),
push the tag manually — the tag names exactly the code that ships:

```bash
git tag vX.Y.Z <sha>
git push origin vX.Y.Z     # v* ruleset grants admins bypass
```

The Expedited Release Audit workflow opens a post-hoc review issue when the
tagged commit is not on `dev`. Never push `dev` directly or bypass its branch
rules.

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

**Rerun an existing tag (recovery)** — transient failures, or replaying
non-blocking channels:

```bash
gh workflow run "Release App" --repo different-ai/openwork -f tag=vX.Y.Z
```

Recovery runs skip tag creation and monotonicity, build source pinned to the
tag, and pick up workflow-file fixes from `dev` automatically (the workflow
definition runs from the dispatched ref; only the checked-out sources are
pinned to the tag).

**If the run fails before the release is published:** land the fix on `dev`
via a normal protected-branch PR and cut the next patch (`pnpm release:cut`).
Only delete/recreate a tag after verifying the GitHub release is still
draft-only:

```bash
git push --delete origin vX.Y.Z
```

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

Confirm `npm view openwork-server version` matches.

---

## Validate a published release

Boot the *released* mac-arm64 desktop binaries (not a source build) through the
packaged journeys. Both specs are `placement: 'local'` in
`evals/scripts/journey-catalog.mjs` and skip loudly (verdict `incomplete`,
exit 2) when `OPENWORK_EVAL_ELECTRON_BINARY` is unset, so a run without a
binary can never pass by accident.

Download and unpack the enterprise + cloud assets of the tag (`ditto` keeps
the signature intact; the quarantine flag must go or macOS blocks the spawn):

```bash
V=X.Y.Z; cd /tmp/ow-release
gh release download "v$V" -R different-ai/openwork -p "openwork-enterprise-mac-arm64-$V.zip" -p "openwork-cloud-mac-arm64-$V.zip"
for f in enterprise cloud; do mkdir -p "$f-$V" && ditto -x -k "openwork-$f-mac-arm64-$V.zip" "$f-$V" && xattr -dr com.apple.quarantine "$f-$V"; done
ENT="/tmp/ow-release/enterprise-$V/OpenWork Enterprise.app/Contents/MacOS/OpenWork Enterprise"
CLD="/tmp/ow-release/cloud-$V/OpenWork Cloud.app/Contents/MacOS/OpenWork Cloud"
```

Fresh-machine gate (no bootstrap): the enterprise build must mount
"Link this app to your organization", the cloud build "Welcome to OpenWork",
each with zero renderer exceptions:

```bash
OPENWORK_EVAL_ELECTRON_BINARY="$ENT" pnpm evals:e2e packaged-first-launch --local
OPENWORK_EVAL_ELECTRON_BINARY="$CLD" pnpm evals:e2e packaged-first-launch --local
```

Activated enterprise install (what every existing enterprise user boots
into): the spec cold-boots a local Den, seeds an activated bootstrap and
asserts the release reports its own version, skips the activation page and
lands on the interactive `/signin` surface without a render crash.
`OPENWORK_EVAL_RELEASED_VERSION` pins the version the binary must report:

```bash
OPENWORK_EVAL_ELECTRON_BINARY="$ENT" OPENWORK_EVAL_RELEASED_VERSION="$V" \
  pnpm evals:e2e released-enterprise-activated --local
```

Baseline-upgrade variant: also download the previous release's enterprise zip
(same steps, e.g. `B=X.Y.W`) and pass it as the baseline. The older release
signs in and selects a workspace on a fresh profile, quits, then the release
under test opens that same profile in place and once more after a restart;
both launches must land in the same signed-in workspace route with zero
renderer exceptions. Without the baseline variable this second test skips and
the run is `incomplete`:

```bash
OPENWORK_EVAL_ELECTRON_BINARY="$ENT" OPENWORK_EVAL_RELEASED_VERSION="$V" \
OPENWORK_EVAL_RELEASED_BASELINE_BINARY="/tmp/ow-release/enterprise-$B/OpenWork Enterprise.app/Contents/MacOS/OpenWork Enterprise" \
  pnpm evals:e2e released-enterprise-activated --local
```

Each command prints a JSON verdict line; only `"verdict":"passed"` with
`"skipped":0` counts. This covers mac-arm64 only, and the update is simulated
by launching the new binary on the old profile — the real electron-updater
download/apply is not exercised.

---

## Notes

- Desktop installer fixes only reach users through a new release — the org
  install door (`/v1/install/:platform`) 302s to versioned assets.
- den-api discovers published versions from the GitHub Releases API at
  runtime (`ee/apps/den-api/src/desktop-releases.ts`): the new version is
  live for orgs as soon as the release is published — no den deploy needed.
  The committed `generated/desktop-versions.ts` is only a cold-start/offline
  fallback.
- AUR publishes by rendering the committed `packaging/aur` template
  (pkgver=0.0.0) in the CI workspace and pushing to aur.archlinux.org — the
  AUR-side commit is that channel's publish protocol; this repo stays
  untouched.
- Native workspace deps must stay converged on one major across all apps —
  electron-builder rebuilds every copy it finds (see #3561/#3563 for the
  three-release outage this caused).
