---
name: openwork-orchestrator-npm-publish
description: |
  Publish the openwork-orchestrator npm package with clean git hygiene.

  Triggers when user mentions:
  - "openwork-orchestrator npm publish"
  - "publish openwork-orchestrator"
  - "bump openwork-orchestrator"
---

## Quick usage (already configured)

1. Ensure you are on the default branch and the tree is clean.
2. Bump versions via the shared release bump (this keeps `openwork-orchestrator` aligned with the app/desktop release).

```bash
pnpm bump:patch
# or: pnpm bump:minor
# or: pnpm bump:major
# or: pnpm bump:set -- X.Y.Z
```

3. Commit the bump.
4. Preferred: publish via the "Release App" GitHub Actions workflow by tagging `vX.Y.Z`.

Manual recovery path (sidecars + npm) below.

```bash
pnpm --filter openwork-orchestrator build:sidecars
gh release create openwork-orchestrator-vX.Y.Z packages/orchestrator/dist/sidecars/* \
  --repo different-ai/openwork \
  --title "openwork-orchestrator vX.Y.Z sidecars" \
  --notes "Sidecar binaries and manifest for openwork-orchestrator vX.Y.Z"
```

5. Build openwork-orchestrator binaries for all supported platforms.

```bash
pnpm --filter openwork-orchestrator build:bin:all
```

6. Publish `openwork-orchestrator` as a meta package + platform packages (optionalDependencies).

```bash
node packages/orchestrator/scripts/publish-npm.mjs
```

7. Verify the published version.

```bash
npm view openwork-orchestrator version
```

---

## Scripted publish

```bash
./.opencode/skills/openwork-orchestrator-npm-publish/scripts/publish-openwork-orchestrator.sh
```

---

## First-time setup (if not configured)

Authenticate with npm before publishing.

```bash
npm login
```

Alternatively, export an npm token in your environment (see `.env.example`).

---

## Notes

- `openwork-orchestrator` is published as:
  - `openwork-orchestrator` (wrapper + optionalDependencies)
  - `openwork-orchestrator-darwin-arm64`, `openwork-orchestrator-darwin-x64`, `openwork-orchestrator-linux-arm64`, `openwork-orchestrator-linux-x64`, `openwork-orchestrator-windows-x64` (platform binaries)
- `openwork-orchestrator` is versioned in lockstep with OpenWork app/desktop releases.
- openwork-orchestrator downloads sidecars from `openwork-orchestrator-vX.Y.Z` release assets by default.
