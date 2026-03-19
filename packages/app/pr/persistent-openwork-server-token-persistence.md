# Persistent OpenWork share tokens

## Why
- Reopening the desktop app regenerated the OpenWork server's collaborator token and minted a new owner token.
- That made the same local worker show different share codes after a full app quit and restart.

## What changed
- The desktop app now stores the OpenWork server token set per workspace in the app data directory.
- The stored collaborator token and host token are reused when the same workspace starts again.
- The owner token is minted once, cached alongside that workspace, and shown again on later launches instead of creating a new one.

## Verification
- `cargo test --lib` in `packages/desktop/src-tauri`
- `cargo test openwork_server::tests::legacy_unpersisted_tokens_change_between_starts --lib -- --exact --nocapture`
- `cargo test openwork_server::tests::reuses_tokens_for_the_same_workspace_after_restart --lib -- --exact --nocapture`

## Before / after screenshots
- Before: `packages/app/pr/screenshots/persistent-openwork-tokens/before-restart-token-change.png`
- After: `packages/app/pr/screenshots/persistent-openwork-tokens/after-restart-token-stable.png`

## Notes
- I did not run the Docker + Chrome MCP end-to-end flow for this change because the behavior lives in the desktop Tauri host path, not the web stack. The verification here exercises the token lifecycle directly in the desktop Rust code.
