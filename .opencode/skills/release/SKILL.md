# Skill: release

Stable releases use one protected-branch review and composable GitHub workflows.
Never bump, tag, or push `dev` locally.

## Start

```bash
pnpm release:prepare -- patch --watch # patch, minor, or major
```

This dispatches `.github/workflows/release-prepare.yml` on `dev`. The workflow:

1. creates deterministic `release/vX.Y.Z` signed commits;
2. bumps app, desktop, server, lockfile, and generated desktop versions;
3. builds the public, Cloud, and enterprise 18-target desktop matrix from one
   exact source SHA;
4. stores exact-attempt immutable artifacts and commits their complete file/hash
   index plus release options under `.github/releases/vX.Y.Z/`;
5. calculates both AUR checksums from those exact staged public Linux tarballs;
6. puts the version and AUR changes in one release PR and enables squash
   auto-merge.

The required human review is on that final PR. Do not open an AUR PR, ask the
user to check merge status, or rerun a whole release after merge.

Before review, a failed prepare may be rerun only as a **full run**. The workflow
validates and reuses its deterministic signed branch and never mixes attempts.

## Continuation

Merging the release PR automatically runs `release-continue.yml`. It tags the
exact merge SHA idempotently and starts separate desktop, server, Daytona, and
AUR stages. Continuation trusts only committed reviewed metadata, never the PR
body. Desktop publication downloads exactly the committed run/attempt, rebuilds
the 18-stage index, and will only keep byte-identical existing assets or upload
missing assets; it never rebuilds or clobbers. AUR verifies both packaging files
and pinned SSH host trust before publishing.

Every workflow summary records inputs, outputs, links, status, and an exact
retry command. Prefer the stage workflow directly:

```bash
gh workflow run release-publish-desktop.yml --repo different-ai/openwork -f tag=vX.Y.Z
gh workflow run release-publish-server.yml --repo different-ai/openwork -f tag=vX.Y.Z
gh workflow run release-daytona-snapshot.yml --repo different-ai/openwork -f tag=vX.Y.Z
gh workflow run release-publish-aur.yml --repo different-ai/openwork -f tag=vX.Y.Z
```

Required credentials fail their requested stage: `COMMIT_SIGNING_KEY`, Apple
signing/notary credentials, optional SignPath credentials when requested,
`NPM_TOKEN` when the server version is unpublished, `DAYTONA_API_KEY`, Render
credentials when production pinning is configured, and `AUR_SSH_PRIVATE_KEY`.

**Setup blocker:** `RELEASE_APP_ID`, `RELEASE_APP_PRIVATE_KEY`, and exact
`RELEASE_APP_LOGIN` must identify a dedicated least-privilege GitHub App. It
must bypass only `v*` tag creation, never `dev` review, and must not be replaced
by a PAT or admin actor. The currently confirmed ruleset requires this setup
before the flow is operational.

See `docs/releases.md` for architecture and recovery details.
