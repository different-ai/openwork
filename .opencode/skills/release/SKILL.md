---
name: release
description: Cut an OpenWork release, release the app, publish a new version, rerun or recover a release tag, verify release assets. Tag-driven GitHub Actions release that makes zero commits to the repo.
---

# Release

The "Release App" workflow (`.github/workflows/release-macos-aarch64.yml`) builds, signs, and publishes the desktop assets. Full runbook: `docs/RELEASING.md`.

Versions live in git tags only. Committed `package.json` files stay at `0.0.0-dev`. CI stamps the tag version at build time (`scripts/release/stamp-version.mjs`). A release makes zero commits to this repo.

Done means the run is green and the GitHub release is published, not draft. Creating the tag is not done. Report with **Honest Verdict**.

## Before you tag: open fix PRs and fork PRs

Run this before `release:cut` or any manual tag. Fork PRs never get Warden clearance, so nothing surfaces them (incident 2026-09-09: a fork PR with the exact blank-window fix sat open while the broken version was tagged).

```bash
bash .opencode/skills/release/scripts/open-fix-prs.sh
```

It lists fix PRs opened since the previous stable tag, fork PRs updated since then, and fork crash or startup fixes of any age. A crash or startup fix for the bug class you ship blocks the same way.

Decide one of these for every listed PR:

- **Land it first.** Review it (fork PRs: `review-a-contributor-pr`), merge to `dev`, then tag.
- **Ship anyway.** Only as a recorded decision: PR numbers, who decided, one-line reason. Put it under `Known open fixes` in the notes PR that `changelog.yml` opens after publish (`docs(changelog): release notes for vX.Y.Z`, branch `automation/changelog-vX.Y.Z-*`). If that PR is not open yet, put it in the release body (`gh release edit vX.Y.Z -R different-ai/openwork --notes-file ...`) and move it later.
- **Not relevant.** Record one line in the same list so the next release does not re-triage it.

Record an empty list too: `Known open fixes: none matched`. Never tag with a non-empty list and no recorded decision.

## Cut a release (default path)

Use **Use the Maintained Lever**: `release:cut`, not hand-made tags.

```bash
pnpm release:cut            # dispatches Release App with bump=patch
pnpm release:cut minor      # or major
pnpm release:cut --version 0.19.0
pnpm release:cut:watch      # same as release:cut, then tails the run
```

By hand:

```bash
gh workflow run "Release App" --repo different-ai/openwork -f bump=patch
```

The run resolves the next version from `v*` tags and tags `origin/dev` HEAD. It verifies the tag (`scripts/release/verify-tag.mjs`: stable format, greater than every stable tag). It stamps the version, builds 18 electron legs, publishes npm, Daytona, and AUR, then flips the draft public.

The tag is created via REST with the org-owned **diff-warden** app token. That app is a `v*` ruleset bypass actor (`WARDEN_APP_ID` + `WARDEN_PRIVATE_KEY` in the `warden-clearance` environment). An actor guard skips the duplicate run its tag triggers. If the push is rejected, fix the ruleset bypass or fall back to an admin tag push.

## Tag-first (expedited, admins only)

For incident response on a commit not yet on `dev`, push the tag yourself. The tag names exactly the code that ships.

```bash
git tag vX.Y.Z <sha>
git push origin vX.Y.Z     # v* ruleset grants admins bypass
```

The Expedited Release Audit workflow opens a post-hoc review issue when the commit is not on `dev`. Never push `dev` directly or bypass its branch rules.

## Watch

```bash
gh run list --repo different-ai/openwork --workflow "Release App" --limit 1
gh run watch <run-id> --repo different-ai/openwork --exit-status --interval 90
```

Publishing is gated on the electron matrix, electron assets, and npm publish. `Publish AUR` (continue-on-error) and `Build + Push Daytona Snapshot` are non-blocking channels. Rerun the same tag once a channel recovers.

**Rerun an existing tag (recovery):**

```bash
gh workflow run "Release App" --repo different-ai/openwork -f tag=vX.Y.Z
```

Recovery skips tag creation and monotonicity checks. Sources are pinned to the tag. Workflow-file fixes come from `dev` automatically.

If the release is already published, recovery skips every desktop build leg and the updater-manifest merge. It replays only npm, AUR, and Daytona. Rebuilding would re-sign installers and could leave `latest*.yml` pointing at missing bytes, so every auto-update fails with `sha512 checksum mismatch` (v0.18.52). Ship new desktop bytes as the next patch.

**Run failed before publish:** land the fix on `dev` via a normal PR and cut the next patch. Delete a tag only after confirming the release is still draft:

```bash
git push --delete origin vX.Y.Z
```

## Verify

```bash
gh release view vX.Y.Z --repo different-ai/openwork --json assets --jq '.assets[].name'
```

Expect `openwork-<platform>-X.Y.Z.*` assets and `latest*.yml` manifests, including:

- `openwork-mac-arm64-X.Y.Z.dmg`
- `openwork-mac-x64-X.Y.Z.dmg`
- `openwork-win-x64-X.Y.Z.exe`

The updater 404s on `latest*.yml` until publish. That is expected during the build window and self-heals. Spot-check a download (302 to the release-assets CDN):

```bash
curl -sI "https://github.com/different-ai/openwork/releases/download/vX.Y.Z/openwork-mac-arm64-X.Y.Z.dmg" | head -2
```

Confirm `npm view openwork-server version` matches.

## Validate a published release

Apply **Prove It on the Real Thing**. Run `validate-a-release` (`.opencode/skills/validate-a-release/SKILL.md`) on the released mac-arm64 zips before calling the version safe to roll out. It boots released enterprise and cloud binaries through `packaged-first-launch` and `released-enterprise-activated`. It checks updater manifest sha512 and signing/notarization.

## Notes

- Desktop installer fixes reach users only through a new release. The org install door (`/v1/install/:platform`) 302s to versioned assets.
- den-api discovers versions from the GitHub Releases API at runtime (`ee/apps/den-api/src/desktop-releases.ts`). No den deploy needed. `generated/desktop-versions.ts` is only a cold-start fallback.
- AUR renders the committed `packaging/aur` template (pkgver=0.0.0) in CI and pushes to aur.archlinux.org. This repo stays untouched.
- Keep native workspace deps converged on one major across all apps. electron-builder rebuilds every copy (#3561/#3563, a three-release outage).
