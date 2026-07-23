# Skill: release

Cut an OpenWork release from `dev`. The "Release App" workflow
(`.github/workflows/release-macos-aarch64.yml`, triggered by a `v*` tag push or
dispatch) builds, signs, and publishes the app assets **and** the paste-gated
installer assets on the same GitHub release. Verified end-to-end on v0.17.37
and v0.17.38.

---

## Prepare

Work from latest `origin/dev` with a clean tree (use a fresh worktree/branch,
e.g. `release/vX.Y.Z`). Confirm dev CI is green.

---

## Bump

```bash
pnpm bump:patch     # or bump:minor / bump:major / bump:set -- X.Y.Z
```

This updates `apps/app`, `apps/desktop`, `apps/orchestrator`, `apps/server`
package.json versions, `ee/apps/den-api/src/generated/desktop-versions.ts`
(den-api's `PUBLISHED_DESKTOP_VERSIONS` — the install door redirects to
`v<PUBLISHED_DESKTOP_VERSIONS[0]>`), and `pnpm-lock.yaml`. Revert incidental
noise (e.g. `*.tsbuildinfo`) before committing.

Commit as `chore(release): vX.Y.Z`, open a PR against `dev`, merge when checks
pass.

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

**If the run fails:** land the fix on `dev` via a normal PR, then move the tag
and let the workflow re-fire — safe only while the release never published:

```bash
git push --delete origin vX.Y.Z
git tag -f vX.Y.Z origin/dev
git push origin vX.Y.Z
```

**Rerun without retagging** (e.g. transient failure):

```bash
gh workflow run "Release App" --repo different-ai/openwork -f tag=vX.Y.Z
```

---

## Verify

```bash
gh release view vX.Y.Z --repo different-ai/openwork --json assets --jq '.assets[].name'
```

Expect the app assets (`openwork-<platform>-X.Y.Z.*`, `latest*.yml`) plus the
installer assets:

- `OpenWork-Installer-mac-arm64.dmg`
- `OpenWork-Installer-mac-x64.dmg`
- `OpenWork-Installer-win-x64.exe`

Spot-check a download URL resolves (302 to release-assets CDN):

```bash
curl -sI "https://github.com/different-ai/openwork/releases/download/vX.Y.Z/OpenWork-Installer-mac-arm64.dmg" | head -2
```

---

## Notes

- Installer fixes only reach users through a new release — the org install
  door (`/v1/install/:platform`) 302s to versioned assets.
- den deployments built from source pick up the new pin via
  `PUBLISHED_DESKTOP_VERSIONS[0]` (den-api `src/version.ts`); no env vars
  required.
- The installer job reuses the mac signing/notarization secrets and keeps the
  placeholder build-config guard (a client-configured build can never publish
  publicly).
