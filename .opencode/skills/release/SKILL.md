---
title: Release flow
description: Step through versioning, tagging, and verification
name: release
---

## Prepare
Confirm the repo is on `main` and clean. Keep changes aligned with OpenCode primitives like `.opencode`, `opencode.json`, skills, and plugins when relevant.

---

## Bump
Update versions in `packages/app/package.json`, `packages/desktop/package.json`, `packages/desktop/src-tauri/tauri.conf.json`, and `packages/desktop/src-tauri/Cargo.toml`. Use one of these commands.

```bash
pnpm bump:patch
pnpm bump:minor
pnpm bump:major
pnpm bump:set -- 0.1.21
```

---

## Merge
Merge the version bump into `main`. Make sure no secrets or credentials are committed.

---

## Tag
Create and push the tag to trigger the Release App workflow.

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

---

## Rerun
If a tag needs a rerun, dispatch the workflow.

```bash
gh workflow run "Release App" --repo different-ai/openwork -f tag=vX.Y.Z
```

---

## Verify
Confirm the run and the published release.

```bash
gh run list --repo different-ai/openwork --workflow "Release App" --limit 5
gh release view vX.Y.Z --repo different-ai/openwork
```
