## Validation

- `pnpm --filter @different-ai/openwork-ui typecheck` (pass)
- `pnpm --filter @different-ai/openwork-ui build` (pass)
- `pnpm --filter @different-ai/openwork-ui test:health` (fails in this environment: `Timed out waiting for /global/health: Unauthorized`)

## End-to-end gate

- Started Docker stack with `packaging/docker/dev-up.sh`
- Verified live UI flow via Chrome MCP at `http://localhost:52357/session`
- Sent prompt: `smoke: hello from chrome mcp`
- Confirmed assistant response: `Hello! How can I help you today?`
- Screenshot: `pr/restart-local-server/chrome-mcp-smoke.png`

## Feature-specific note

- This change adds a desktop local-host restart action in Settings.
- The Docker/Web flow verifies app-server integration health; the restart action itself is desktop-only (Tauri runtime).
