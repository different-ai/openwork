---
name: openwrk-npm-publish
description: |
  Publish the openwrk npm package with clean git hygiene.

  Triggers when user mentions:
  - "openwrk npm publish"
  - "publish openwrk"
  - "bump openwrk"
---

## Quick usage (already configured)

1. Ensure you are on the default branch and the tree is clean.
2. Bump the version in `packages/headless/package.json`.
3. Commit the bump.
4. Build sidecar artifacts and publish them to a release tag.

```bash
pnpm --filter openwrk build:sidecars
gh release create openwrk-vX.Y.Z packages/headless/dist/sidecars/* \
  --repo different-ai/openwork \
  --title "openwrk vX.Y.Z sidecars" \
  --notes "Sidecar binaries and manifest for openwrk vX.Y.Z"
```

5. Publish the package.

```bash
pnpm --filter openwrk publish --access public
```

6. Verify the published version.

```bash
npm view openwrk version
```

---

## Scripted publish

```bash
./.opencode/skills/openwrk-npm-publish/scripts/publish-openwrk.sh
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

- `pnpm publish` requires a clean git tree.
- This publish flow is separate from app release tags.
- openwrk downloads sidecars from `openwrk-vX.Y.Z` release assets by default.
