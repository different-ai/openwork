# Tauri → Electron migration runbook

Three scripts. Run in order. Each one is idempotent and prints what it
will do before it does it.

```
scripts/migration/01-cut-migration-release.mjs   # cut v0.12.0, the last Tauri release
scripts/migration/02-validate-migration.mjs      # guided post-release smoke test
scripts/migration/03-post-migration-cleanup.mjs  # delete src-tauri, flip defaults (run after users stabilize)
```

## When to run what

| Step | When | What user-visible effect |
| ---- | ---- | ------------------------ |
| 01   | Ready to ship the migration | Tauri users see "OpenWork is moving" prompt on next update |
| 02   | Right after the workflow finishes | Dogfood validation — no user effect |
| 03   | After 1-2 weeks of stable Electron telemetry | Dev repo is Electron-only; no user effect |

## Current safe-prep rollout

The next release is intentionally **non-destructive**:

- Tauri remains the main/stable desktop build and keeps using the existing
  Tauri updater feed (`latest.json`).
- Electron is built as a preview artifact on every push by
  `.github/workflows/build-electron-desktop.yml`.
- Pushes to `dev` or `main` refresh the rolling prerelease bucket at
  <https://github.com/different-ai/openwork/releases/tag/electron-preview-latest>.
- The Debug settings migration controls are Tauri-only and developer-mode only.
  The default action, **Prepare migration data**, only writes
  `migration-snapshot.v1.json`; it does not quit, replace, or delete Tauri.
- The install handoff requires a pasted Electron artifact URL plus two explicit
  confirmations. On macOS the native handoff keeps the previous bundle at
  `OpenWork.app.migrate-bak` for rollback.

Use this safe-prep release to test migration data capture and preview downloads
before enabling any user-facing migration prompt.

### Sharing Electron preview downloads

1. Wait for `Build Electron Desktop Preview` to finish on the target commit.
2. Share the rolling preview release page:
   <https://github.com/different-ai/openwork/releases/tag/electron-preview-latest>
3. Ask testers to download the matching platform artifact:
   - macOS Apple Silicon: `openwork-mac-arm64-*.dmg` or `.zip`
   - macOS Intel: `openwork-mac-x64-*.dmg` or `.zip`
   - Windows: `openwork-win-x64-*.exe`
   - Linux: `openwork-linux-x64-*.AppImage` or `.tar.gz`

Do not point stable Tauri users at these preview assets as an automatic update
until the explicit migration release is cut and validated.

## 01 — cut-migration-release.mjs

```bash
node scripts/migration/01-cut-migration-release.mjs --version 0.12.0 \
  --mac-url 'https://github.com/different-ai/openwork/releases/download/v0.12.0/OpenWork-darwin-arm64-0.12.0-mac.zip' \
  --dry-run         # inspect planned changes first
```

What it does:

1. Refuses to run on a dirty working tree.
2. Runs `pnpm bump:set -- <version>` (bumps all 5 sync files per
   AGENTS.md release runbook).
3. Creates a release-config fragment at
   `apps/app/.env.migration-release` setting
   `VITE_OPENWORK_MIGRATION_RELEASE=1` and the per-platform download
   URLs. The `Release App` workflow copies this into the build env so
   the migration prompt is dormant on every other build but live for
   this release.
4. Commits the version bump.
5. Creates and pushes the `vX.Y.Z` tag.
6. Prints `gh run watch` command so you can follow the workflow.

Drop `--dry-run` to actually execute.

## 02 — validate-migration.mjs

```bash
node scripts/migration/02-validate-migration.mjs --tag v0.12.0
```

Interactive guided check. Prints steps and confirms each one before
moving on:

1. Downloads the Tauri DMG for the tag and verifies its minisign
   signature (reuses the existing updater public key).
2. Downloads the Electron .zip for the tag and verifies the Apple
   Developer ID signature.
3. Prompts you to install the Tauri DMG on a fresh machine / VM and
   confirm the migration prompt appears.
4. Drops a canary key into localStorage on the Tauri side, triggers
   "Install now", and checks that the canary survives into the Electron
   launch via `readMigrationSnapshot` + localStorage inspection.
5. Reports pass/fail for each step.

Needs `--skip-manual` to run the automated parts only. Useful inside a
release-review meeting as a shared checklist.

## 03 — post-migration-cleanup.mjs

```bash
node scripts/migration/03-post-migration-cleanup.mjs --dry-run
```

Once v0.12.x has been stable for 1-2 weeks:

1. Flips `apps/desktop/package.json` defaults:
   - `dev` → `node ./scripts/electron-dev.mjs`
   - `build` → `node ./scripts/electron-build.mjs`
   - `package` → `pnpm run build && pnpm exec electron-builder …`
2. Removes `apps/desktop/src-tauri/` entirely.
3. Strips `@tauri-apps/*` from `apps/app/package.json` and
   `apps/story-book/package.json`.
4. Collapses `apps/app/src/app/lib/desktop-tauri.ts` into
   `desktop.ts` (direct Electron implementation).
5. Updates `AGENTS.md`, `ARCHITECTURE.md`, `README.md`, translated
   READMEs to drop Tauri references.
6. Updates the release runbook in `AGENTS.md` to remove the
   `Cargo.toml` and `tauri.conf.json` version-bump entries.
7. Creates a commit with the combined cleanup.

Drop `--dry-run` to actually perform the changes.

## Emergency rollback

If the v0.12.0 migration release is bad:

- Users on Electron already: ship v0.12.1 via electron-updater. Same
  mechanism as any other update.
- Users still on Tauri: the migrate prompt is gated on
  `VITE_OPENWORK_MIGRATION_RELEASE=1` at build time. Re-cut the
  release with that flag unset, minisign-sign a replacement
  `latest.json`, and users who haven't clicked "Install now" yet will
  fall back to the non-migrating release.
- Users mid-migration: the Rust `migrate_to_electron` command keeps
  the previous `.app` at `OpenWork.app.migrate-bak`. Instruct users
  to `mv OpenWork.app.migrate-bak OpenWork.app` if the Electron
  launch fails.
