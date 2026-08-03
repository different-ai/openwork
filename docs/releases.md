# Stable releases

OpenWork stable releases require exactly one human review. Start from the CLI:

```bash
pnpm release:prepare -- patch --watch
```

Or run **Prepare Release** in GitHub Actions and choose `patch`, `minor`, or
`major`. Do not commit version bumps, tag, or push `dev` locally.

## One-review architecture

The prepare workflow creates signed commits on deterministic branch
`release/vX.Y.Z`, bumps every release version, and stages all 18 desktop targets
as immutable Actions artifacts. It merges updater manifests and calculates AUR
x86_64/aarch64 checksums from the exact staged public Linux tarballs. Only then
does it open one PR containing both version and packaging changes and enable
auto-merge.

The reviewed tree records authoritative release data in
`.github/releases/vX.Y.Z/release.json` and the complete 18-stage file/hash index
in `artifacts.json`. The PR body is informational only. Each matrix artifact
records its exact source SHA, run ID, attempt, files, sizes, and hashes. Missing,
duplicate, unexpected, or mixed-attempt data fails before the PR opens and is
validated again across runs before publication.

Review that final diff once. Protected `dev` receives only GitHub's normal
reviewed squash merge; automation never pushes it directly or bypasses review.

When the release App-authored PR merges, **Continue Merged Release** checks out
the exact merge SHA, validates the committed metadata/tree and exact PR author,
creates `vX.Y.Z` on that merge SHA (or verifies an existing identical tag), and
runs composable stages:

- **Desktop:** downloads the staged artifacts cross-run. Existing release assets
  must be byte-identical; differing assets fail instead of being clobbered.
- **Server:** publishes `openwork-server` from the exact tag, or succeeds when
  that version already exists.
- **Daytona:** publishes the exact tagged snapshot independently.
- **AUR:** checks merged `PKGBUILD`/`.SRCINFO` against the same public Linux
  assets, then pushes those files directly to AUR. It never opens another PR.

The continuation summary is the release dashboard. It shows stage states,
inputs, outputs, links, and exact retry commands. Retry only a failed stage; a
completed stage and its artifact bytes remain immutable. Missing publication
credentials fail the requested stage instead of silently skipping it.

Prepare artifacts are retained for 90 days. Merge the reviewed release PR while
its recorded run/attempt is available.

If prepare fails before review, rerun the **entire** prepare run. Every full
rerun gets a new attempt; attempts are never mixed. The deterministic release
branch is reused only after its release commits, accepted SSH signer, and
allowed changed paths validate. After merge, retry only the failed publication
stage.

## Release GitHub App setup — current operational blocker

**The composable release is not operational until this setup is complete.** The
current `v*` tag ruleset permits only admins/repository administrators. Create a
dedicated GitHub App, install it only on `different-ai/openwork`, and configure:

- secret `RELEASE_APP_ID`;
- secret `RELEASE_APP_PRIVATE_KEY`;
- repository variable `RELEASE_APP_LOGIN` with the exact installation bot login
  (for example `openwork-release[bot]`);
- minimum repository permissions: Contents read/write and Pull requests
  read/write; do not grant administration permission;
- add this App, and only this App, as a narrowly scoped bypass actor on the
  `v*` **tag creation** ruleset.

The App must **not** bypass `dev` branch protection and must not be granted an
admin/repository-admin role. Automation has no tag update, force-push, or delete
path: it may only create a missing exact tag or verify an identical one. Do not
substitute a PAT. App-authored PR/merge operations are required so GitHub emits
the merge event that starts continuation.

## Other repository requirements

- Repository auto-merge must be enabled. PR operations use only the dedicated
  App installation token, not `GITHUB_TOKEN` or a PAT.
- `dev` must keep its normal one-human-review and signed-commit protection; the
  release App and Actions actor must have no bypass there.
- `COMMIT_SIGNING_KEY` must be an SSH private key whose public key is registered
  as a signing key for the configured release identity.
- Publication secrets are required only when their stage is requested: Apple
  signing/notary values, SignPath values when Windows signing is selected,
  `NPM_TOKEN`, `DAYTONA_API_KEY` plus configured Render pin credentials, and
  `AUR_SSH_PRIVATE_KEY`.
- AUR host keys are accepted only after all official RSA, ECDSA, and Ed25519
  fingerprints published by `https://aur.archlinux.org/` match the pinned
  values in `scripts/aur/pin-host-keys.mjs`.
