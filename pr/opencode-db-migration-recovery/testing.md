## Opencode DB Migration Recovery - verification guide

### What changed

- Added a desktop command to run `opencode db migrate` from OpenWork.
- Added workspace recovery flow to stop engine, migrate, and restart once.
- Added onboarding and settings UI entry points for "Fix migration".
- Increased first local boot health timeout for `host-start` and `bootstrap-local`.

### Screenshots in this folder

- `session-smoke-response.png`
- `settings-general.png`
- `settings-advanced.png`

Note: this environment was connected to a remote workspace surface, so desktop-only migration controls were not rendered in Chrome MCP screenshots.

### Third-party test steps

1. Install dependencies and validate builds.

```bash
pnpm install
pnpm --filter @different-ai/openwork-ui typecheck
pnpm --filter @different-ai/openwork-ui build
pnpm --filter @different-ai/openwork-desktop tauri build --debug
```

2. Run desktop app and verify recovery action appears.

```bash
pnpm --filter @different-ai/openwork-desktop tauri dev
```

3. In the desktop app, create or open a local workspace and force local startup preference.

4. Trigger a migration failure scenario (example: use an older `opencode` binary or stale `.opencode/opencode.db` schema), then confirm:
   - onboarding error panel shows `Fix migration`
   - settings -> Advanced shows `Migration recovery`
   - clicking `Fix migration` runs migrate, then retries local start once

5. Confirm fallback copy for older CLIs without `db migrate`:
   - expected message points user to upgrading OpenCode.

6. Optional Docker + Chrome MCP gate for UI sanity:

```bash
packaging/docker/dev-up.sh
```

Use the printed Web UI URL, run one smoke prompt/response flow, then stop with the printed `docker compose -p ... down` command.
