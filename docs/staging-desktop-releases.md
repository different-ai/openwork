# Staging desktop releases

## Proposal

OpenWork desktop staging builds use an isolated GitHub prerelease lane before
a stable release. A staging tag stamps the public Electron app with a SemVer
prerelease version and produces the same six public desktop targets as the
stable pipeline:

| Platform | Architectures |
| --- | --- |
| macOS | arm64, x64 |
| Linux | arm64, x64 |
| Windows | arm64, x64 |

The lane intentionally does not publish Cloud or enterprise distributions,
npm packages, OpenWork sidecar releases, Daytona snapshots, AUR changes, or a
stable updater pointer. Stable releases remain owned by the `Release App`
workflow.

## Version and tag contract

Use immutable annotated tags in this exact format:

```text
vMAJOR.MINOR.PATCH-staging.SEQUENCE
```

For example, candidates before `v0.18.6` are:

```text
v0.18.6-staging.1
v0.18.6-staging.2
```

`SEQUENCE` is a non-negative integer without leading zeroes. A staging tag must
point to a commit reachable from `dev`, and its base version must be newer than
the app version in that commit.

The workflow writes `0.18.6-staging.1` into `apps/app/package.json` and
`apps/desktop/package.json` only inside the build runner. The repository stays
on its stable source version, and the staged app reports the staging version in
its package metadata and UI. When `v0.18.6` is later released, SemVer ranks that
stable version above its prereleases.

Electron's machine build version is set separately to the numeric base version
(`0.18.6` in this example). This keeps macOS `CFBundleVersion` and Windows file
metadata numeric while preserving the full staging version as the user-facing
application version.

The production release workflow explicitly excludes `v*-staging.*`, preventing
a staging tag from publishing stable release side effects.

## GitHub environment

Create a GitHub Actions environment named `staging` before the first staged
release. Recommended settings:

1. Allow only tags matching `v*-staging.*`.
2. Require one release reviewer and prevent self-review when the repository
   plan supports those controls.
3. Keep signing credentials in the same repository secret boundary used by the
   stable release until environment-scoped secret migration is planned.
4. Set `STAGING_MACOS_NOTARIZE=true` (the workflow also defaults to the stable
   `MACOS_NOTARIZE` setting).
5. Set `STAGING_SIGN_WINDOWS=true` only after the SignPath staging path is
   confirmed. Windows staging installers are clearly marked unsigned otherwise.

The build creates a draft prerelease first. All platform artifacts and merged
updater manifests must succeed before the final job requests the `staging`
environment and publishes the prerelease.

GitHub documents environment approvals, tag restrictions, and secret access in
[Deployments and environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments).

## Cut a staging build

Start from an up-to-date `dev` commit:

```bash
git switch dev
git pull --ff-only
git tag -a v0.18.6-staging.1 -m "OpenWork 0.18.6 staging 1"
git push origin v0.18.6-staging.1
```

The tag push starts `Stage Desktop App`. A maintainer can also rerun a failed
candidate with the workflow's manual `tag` input. Do not move or reuse a
published tag; increment the staging sequence.

## Promotion and rollback

Promotion is a new stable tag through the existing release process:

```text
v0.18.6-staging.1 -> v0.18.6-staging.2 -> v0.18.6
```

There is no automatic promotion and no staging-to-stable artifact copy. Stable
artifacts are rebuilt from the stable tag with the production checks and
publication steps.

If a staging candidate is bad, leave its immutable tag as an audit record,
withdraw the prerelease if necessary, fix `dev`, and create the next staging
sequence. If any matrix build fails, the release stays in draft form and can be
recovered by manually rerunning the workflow for the same tag.
