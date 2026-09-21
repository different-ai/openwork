# Local Code Mode preview

Run from the feature worktree. `code-mode-preview` owns its disposable Den
database and processes; `app-web` owns an isolated local app runtime.

```sh
pnpm world up code-mode-preview --place local --stage code-mode --detach --timeout 600000
pnpm world outputs code-mode-preview --stage code-mode
```

Use the returned `denWeb` and `denApi` origins separately. Den web's
`/api/den` routes redirect to the API origin; a browser redirect across ports
is not a same-origin proxy. The explicit API target below bypasses that
redirect while keeping the sign-in page on the web origin.

```sh
OPENWORK_DEV_HEADLESS_WEB_DEN_PROXY=1 \
OPENWORK_DEV_DEN_PROXY_TARGET=<denWeb> \
OPENWORK_DEV_DEN_API_PROXY_TARGET=<denApi> \
pnpm world up app-web --place local --stage code-mode-connected --detach --timeout 600000 \
  --env OPENWORK_DEV_HEADLESS_WEB_DEN_PROXY \
  --env OPENWORK_DEV_DEN_PROXY_TARGET \
  --env OPENWORK_DEV_DEN_API_PROXY_TARGET -- --lifetime 480
```

The separate API target is local-only, must be a nonsecret HTTP(S) origin,
and must be selected explicitly. It is ignored as ambient environment.
Production builds and production preview servers do not enable this proxy.
No credentials are injected by the proxy; requests retain the caller's auth.

Sign into Den with the account from the owner-only world outputs. Enable
Code Mode in Settings > General and save. Use the existing Den desktop
handoff page (`/?mode=sign-in&desktopAuth=1&desktopScheme=openwork`), then
paste its one-time code into app-web's **Paste sign-in code** control.
No synthetic activation or provider credentials are seeded.

Check that app-web shows the preview owner and that its `openwork-cloud`
MCP reports connected. A same-origin `/api/den/v1/org` request should return
the preview organization without redirecting. Code Mode's model-facing
MCP catalog advertises `execute_capability_script` and `capability_helper`;
the generic routers retain app-only visibility for existing cards. This
advertisement is not proof of the engine's actual model-facing catalog.

## Deployment gate

The organization opt-in is inert unless the Den deployment sets
`DEN_CODE_MODE_OPT_IN_ENABLED=true` (default off). While off:

- `PATCH /v1/org` rejects `codeModeEnabled: true` with `code_mode_unavailable`;
  turning it off is always allowed so a stale stored flag can be cleared.
- The agent MCP catalog stays in standard mode even for an organization whose
  metadata already stores `codeModeEnabled: true`.
- Den web shows the Code Mode row locked with "Not available yet" and names the
  deployment administrator as the owner of the change (DESIGN P4, C5).
- `GET /v1/org` advertises `capabilities.codeModeOptIn` so clients render the
  same locked state.

This preview world and the `code-mode-org-opt-in` journey set the switch
explicitly to exercise the enabled path; `code-mode-policy.test.ts` and
`generated-artifact-view-rollout.test.ts` cover the default-off path.

## OpenCode boundary release blocker

Do not enable the deployment gate for OpenWork clients yet:

Cloud submission readiness fails closed when an opt-in catalog cannot
demonstrate both Code Mode entry tools without the private App routers. Generic
model tool-call capability is not a substitute for that projection. This is a
compatibility guard, not a supported direct-tool integration or proof that
every other MCP client filters visibility correctly.

- Pinned v1 `v1.18.30` (`3104c1428ec91f809e5ab86631300de41eb6952e`)
  returns from `SessionTools.resolve` before adding any direct MCP tools when
  `experimentalCodeMode` is enabled. Its `CodeModeTool` wraps the MCP catalog
  without a per-server bypass. Disabling that flag globally would change
  unrelated MCP behavior.
  The pinned plugin API's `tool.definition` hook edits descriptions and schemas;
  it does not expose the final tool map. Execution hooks run after projection,
  so they cannot repair model-catalog leakage. Source inspected at
  `anomalyco/opencode@3104c1428ec91f809e5ab86631300de41eb6952e`,
  `packages/opencode/src/session/tools.ts` and `packages/plugin/src/index.ts`.
- Pinned v2 `0.0.0-beta-19086` accepts per-server `codemode: false` and exposes
  `openwork-cloud_execute_capability_script` directly. However, a real provider
  request also contains `openwork-cloud_execute_capability` even when the MCP
  advertises `_meta.ui.visibility: ["app"]`. Enabling that bypass alone would
  leak the app-only router into the model catalog.
- `pnpm exec bun test apps/server/src/code-mode-boundary.integration.test.ts`
  cold-boots the integrity-pinned v2 binary with an isolated profile and a
  synthetic local MCP/model endpoint. It characterizes the blocker; a passing
  result is **not** a passing direct-tool/app-only isolation acceptance test.

Follow-up inspection on September 20, 2026: stable v1 `v1.18.31`
(`a97622c801f4ca571530ddc51076af659a9c32cd`) does not change the session
MCP projection or plugin hook files from the pinned v1. The latest published v2
beta `0.0.0-beta-19271` also passes the leakage characterization above when
substituted temporarily using its registry integrity. Neither observation
establishes a supported boundary. The production pins remain unchanged.

The Code Mode journey explicitly sets `OPENWORK_EVAL_MYSQL8=1` for its owned
Daytona Den. The default server snapshot supplies MariaDB 11.8.6, which rejects
MySQL `FOR SHARE` queries during invitation acceptance (`ER_PARSE_ERROR`). The
opt-in boot path installs checksum-pinned MySQL 8.4.11 into a fresh disposable
directory, binds it to loopback, and leaves production locking and shared
snapshots unchanged. Sandbox teardown owns the database's lifetime. This path
is x86_64-only and refuses to reuse an existing fixture directory.

Required before release: an engine version/API that preserves app-only
filtering while exposing Den tools directly, with unrelated MCPs remaining in
their existing Code Mode path. Then wire that supported boundary in OpenWork,
replace the blocker assertion with model-catalog exclusion, and verify direct
script execution/results through that same provider transport. Keep the App
host's router access and Den's existing Keep/Share backend.

`--lifetime` is set when starting a world. Use a new app-web stage to select
new origins or obtain a new lease without interrupting another preview.
Den stays running until explicitly stopped:

```sh
pnpm world down app-web --stage code-mode-connected
pnpm world down code-mode-preview --stage code-mode
```
