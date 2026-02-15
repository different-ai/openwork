# Release checklist

OpenWork releases should be deterministic, easy to reproduce, and fully verifiable with CLI tooling.

## Preflight

- Sync the default branch (currently `dev`).
- Run `pnpm release:review` and fix any mismatches.
- If you are building sidecar assets, set `SOURCE_DATE_EPOCH` to the tag timestamp for deterministic manifests.

## App release (desktop)

1. Bump versions (app + desktop + Tauri + Cargo):
    - `pnpm bump:patch` or `pnpm bump:minor` or `pnpm bump:major`
2. Re-run `pnpm release:review`.
3. Build sidecars for the desktop bundle:
   - `pnpm --filter @different-ai/openwork prepare:sidecar`
4. Commit the version bump.
5. Tag and push:
   - `git tag vX.Y.Z`
   - `git push origin vX.Y.Z`

## openwrk (npm + sidecars)

1. Bump versions (includes `packages/headless/package.json`):
   - `pnpm bump:patch` or `pnpm bump:minor` or `pnpm bump:major`
2. Build sidecar assets and manifest:
   - `pnpm --filter openwrk build:sidecars`
3. Create the GitHub release for sidecars:
   - `gh release create openwrk-vX.Y.Z packages/headless/dist/sidecars/* --repo different-ai/openwork`
4. Publish the package:
   - `pnpm --filter openwrk publish --access public`

## openwork-server + opencode-router (if version changed)

- `pnpm --filter openwork-server publish --access public`
- `pnpm --filter owpenwork publish --access public`

## Verification

- `openwrk start --workspace /path/to/workspace --check --check-events`
- `gh run list --repo different-ai/openwork --workflow "Release App" --limit 5`
- `gh release view vX.Y.Z --repo different-ai/openwork`

Use `pnpm release:review --json` when automating these checks in scripts or agents.

## AUR

`Release App` publishes the Arch AUR package automatically after the Linux `.deb` asset is uploaded.

Required repo config:

- GitHub Actions secret: `AUR_SSH_PRIVATE_KEY` (SSH key with push access to the AUR package repo)
- Optional repo variable: `AUR_REPO` (defaults to `openwork`)

## npm publishing

If you want `Release App` to publish `openwrk`, `openwork-server`, and `owpenwork` to npm, configure:

- GitHub Actions secret: `NPM_TOKEN` (npm automation token)

If `NPM_TOKEN` is not set, the npm publish job is skipped.
