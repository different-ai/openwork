# Pre-alpha release channels

OpenWork has two unsupported, independently evolving pre-alpha integration
branches:

- `canary`
- `experimental`

They are intended for rapid, opinionated product iteration before work is ready
for the `dev` alpha channel.

## Branch contract

- `dev` changes flow into `canary` and `experimental`.
- `canary` and `experimental` are never merged wholesale into `dev`.
- A feature branch may be merged independently into any or all three branches.
- A channel-only change reaches `dev` through a separate reviewed feature PR,
  not by merging the channel branch.
- Direct pushes to `canary` and `experimental` are allowed.
- Prefer merge commits or reverts on the channel branches after releases exist;
  do not rewrite commits that already have release tags.

For example, synchronize a channel with:

```bash
git switch canary
git merge origin/dev
git push origin canary
```

Repeat the same operation independently for `experimental`.

## Build and release behavior

Every push to either channel runs
`.github/workflows/pre-alpha-macos-aarch64.yml`. The workflow intentionally
does not run the normal OpenWork test suites. It performs only the dependency
installation and signed/notarized macOS arm64 application build required to
produce an installable artifact.

Successful runs produce immutable prerelease tags:

```text
canary-macos-v0.18.12-canary.<run>-<sha>
experimental-macos-v0.18.12-experimental.<run>-<sha>
```

The packaged versions follow SemVer prerelease notation:

```text
0.18.12-canary.<run>+<sha>
0.18.12-experimental.<run>+<sha>
```

Rolling updater manifests are published at:

```text
canary-macos-latest/latest-mac.yml
experimental-macos-latest/latest-mac.yml
```

The tag prefixes deliberately do not begin with `v`, so they cannot trigger
the stable `v*` application, npm, EE image, AUR, or Daytona release paths.

## Reduced CI/CD

The repository's standard test and i18n workflows target `dev`, so direct
pushes to these two channel branches do not run them. Each of the five Vercel
projects has a `vercel.json` that also disables Git-triggered deployments for
the exact `canary` and `experimental` branch names.

These builds are unsupported and may contain incomplete migrations, broken
flows, or features that are reverted without promotion.
