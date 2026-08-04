# Skill: release

Cut an OpenWork release from `dev`. The "Release App" workflow
(`.github/workflows/release-macos-aarch64.yml`, triggered by a `v*` tag push or
dispatch) builds, signs, and publishes the standard desktop app assets on the
GitHub release.

---

## Prepare

Work from latest `origin/dev` with a clean tree (use a fresh worktree/branch,
e.g. `release/vX.Y.Z`). Confirm dev CI is green.

`dev` is protected. Never push directly to `dev`, force-push it, delete it, or
use admin bypasses. All release prep changes must land through a PR with the
normal branch-protection flow:

- at least one approval;
- code-owner approval where configured;
- stale approvals dismissed after every new push;
- latest push approved by someone other than the pusher;
- all conversations resolved;
- squash or rebase merge only, so the resulting protected-branch commit is
  GitHub-created/signed and history stays linear.

---

## Bump

```bash
pnpm bump:patch     # or bump:minor / bump:major / bump:set -- X.Y.Z
```

This updates `apps/app`, `apps/desktop`, `apps/server`
package.json versions, `ee/apps/den-api/src/generated/desktop-versions.ts`
(den-api's `PUBLISHED_DESKTOP_VERSIONS` — the install door redirects to
`v<PUBLISHED_DESKTOP_VERSIONS[0]>`), and `pnpm-lock.yaml`. Revert incidental
noise (e.g. `*.tsbuildinfo`) before committing.

Commit as `chore(release): vX.Y.Z`, open a PR against `dev`, and merge only
after the protected-branch requirements above are satisfied. Do not add empty
status-check/workflow requirements just to block a release; use real checks and
human review.

---

## Tag

Tag the merge commit on dev; the tag push triggers Release App:

```bash
git fetch origin dev
git tag vX.Y.Z origin/dev
git push origin vX.Y.Z
```

---

## Watch

```bash
gh run list --repo different-ai/openwork --workflow "Release App" --limit 1
gh run watch <run-id> --repo different-ai/openwork --exit-status --interval 90
```

The run includes a Windows test job; any test failure blocks publish (the
release stays draft).

**If the run fails before the release is published:** land the fix on `dev` via
a normal protected-branch PR. Prefer creating a new patch tag if any release
assets may already have been consumed. Only delete/recreate the tag and draft
release when you have verified the GitHub Release is still draft-only and no
published asset was available:

```bash
git push --delete origin vX.Y.Z
git tag -f vX.Y.Z origin/dev
git push origin vX.Y.Z
```

**Rerun without retagging** (e.g. transient failure):

```bash
gh workflow run "Release App" --repo different-ai/openwork -f tag=vX.Y.Z
```

The release workflow may open an AUR packaging PR instead of pushing packaging
updates directly to `dev`. That is expected under branch protection. Get that PR
reviewed and squash/rebase-merged, then rerun the release workflow with the same
tag so the AUR publish step can observe that packaging is already up to date.

When the workflow opens an AUR packaging PR, immediately inform the user with
the PR URL and the next required action. Then use the `question` tool to ask
exactly:

> Has the PR been merged?

Offer `Yes` and `No` options. Continue the release only when the user answers
`Yes`. If the user answers `No`, do not proceed; wait a few minutes, check the
PR merge status with `gh pr view <pr-url> --json merged,state`, and ask the same
question again. Repeat this sleep/check/question loop until the PR is merged or
the user explicitly stops the release.

---

## Verify

```bash
gh release view vX.Y.Z --repo different-ai/openwork --json assets --jq '.assets[].name'
```

Expect the app assets (`openwork-<platform>-X.Y.Z.*`, `latest*.yml`), including:

- `openwork-mac-arm64-X.Y.Z.dmg`
- `openwork-mac-x64-X.Y.Z.dmg`
- `openwork-win-x64-X.Y.Z.exe`

Spot-check a download URL resolves (302 to release-assets CDN):

```bash
curl -sI "https://github.com/different-ai/openwork/releases/download/vX.Y.Z/openwork-mac-arm64-X.Y.Z.dmg" | head -2
```

---

## Notes

- Desktop installer fixes only reach users through a new release — the org install
  door (`/v1/install/:platform`) 302s to versioned assets.
- den deployments built from source pick up the new pin via
  `PUBLISHED_DESKTOP_VERSIONS[0]` (den-api `src/version.ts`); no env vars
  required.
