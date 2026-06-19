# Default OpenWork Marketplace onboarding flow

End-to-end 5-star onboarding flow for the current capability level: Den gets the
user to the desktop app, and the desktop app loads a backend-provisioned default
Marketplace containing built-in OpenWork extension capabilities.

## Acceptance target

- Den download/sign-in copy does not claim that Den creates or loads a desktop workspace.
- Den introduces the built-in OpenWork Marketplace and explains it appears after desktop sign-in.
- A signed-in desktop user can open Settings -> Marketplace and see `OpenWork Marketplace` from Den.
- `OpenWork Marketplace` includes built-in extension entries such as `OpenWork Browser`, `Computer Use`, `OpenAI Image Gen`, `Google Workspace`, and `Ollama`.
- Built-in OpenWork entries are rendered as cloud Marketplace entries with a `Built-in` status, not as locally injected desktop Marketplace rows.
- Signed-out desktop users can still use OpenWork, but Marketplace nudges sign-in for built-in extensions and organization marketplaces.
- A non-built-in assigned Marketplace plugin can be imported into an active desktop workspace.
- Imported plugin resources appear in `My Extensions` and materialize into `.opencode` workspace files.
- The chat composer can run a prompt that uses the imported plugin/skill once the workspace runtime is ready.

## Preflight

1. Start a Daytona Den server sandbox from the branch under test.
2. Start a Daytona Electron sandbox from the same branch, pointed at the Den server.
3. Validate Den Web/API health.
4. Validate Electron bootstrap uses the Daytona Den URLs.
5. If recording, verify `wmctrl` and `xdotool` are installed in the Electron sandbox.
6. Close stale native dialogs such as `Authorize folder` before recording.
7. Prefer Den Web production mode (`next build` + `next start`) for the founder journey recording; Next dev can fail to hydrate through Daytona proxy/HMR.
8. Validate dev auth before UI recording: direct Den API sign-in with the seeded user should return `200` when `OPENWORK_DEV_MODE=1`.

## Demo Standard

- The primary demo should be a full click-by-click recording through Chrome and Electron, not a recording of the final state after hidden setup.
- Use `browser_snapshot` UIDs with `browser_click` and `browser_fill` for normal user actions.
- Use `browser_eval`, direct APIs, localStorage writes, direct URLs, or filesystem checks only when the UI cannot perform the step yet.
- When a shortcut is used, label it as setup or a product gap and return to a visible UI state before continuing the recording.
- The recording should show the user-visible value: onboarding copy, Marketplace sync, install action, My Extensions/materialization status if visible, and chat response.
- Terminal logs, API responses, and file checks are supporting evidence. They do not replace a visible product demo.

## Flow 1: Den download handoff copy

**Goal:** Den accurately sets expectations before desktop install.

Steps:

1. Open Den landing `/download` in browser.
2. Inspect the hero and three-step cards.

Expected outcome:

- Page includes `built-in OpenWork Marketplace` or `built-in Marketplace`.
- Page says the user downloads/opens the desktop app after Cloud signup.
- Page says the workspace is created in the app.
- Page does not say `Create a workspace` or `Set up your personal or team workspace before installing.`

## Flow 2: signed-out desktop Marketplace nudge

**Goal:** OpenWork remains usable without account, while Marketplace clearly asks
for Cloud sign-in.

Steps:

1. Launch Electron without a Cloud Account session.
2. Create or open a local workspace.
3. Open Settings -> Marketplace.

Expected outcome:

- The Marketplace page renders.
- The notice says the user can use OpenWork without an account.
- The notice says sign-in loads the Marketplace, built-in extensions, and organization marketplaces.
- No locally injected built-in extension cards appear before sign-in.

## Flow 3: default Marketplace provisioning after desktop sign-in

**Goal:** Desktop sign-in causes Den to provision and return the default OpenWork
Marketplace for any user/org.

Steps:

1. Sign Electron into OpenWork Cloud using the Daytona Den handoff flow.
2. Create or open a local workspace.
3. Open Settings -> Marketplace.
4. Click `Refresh` if the Marketplace list has not loaded yet.
5. Open `Filters` and inspect marketplace options.
6. Search for `OpenWork Browser`.
7. Open the `OpenWork Browser` card.

Expected outcome:

- `OpenWork Marketplace` appears as a marketplace option.
- `OpenWork Browser` appears as a Marketplace card from Den.
- The card shows `Built-in` or an equivalent built-in/ready status.
- The detail modal shows OpenWork Browser setup/resource details from the Den extension manifest.
- The detail modal does not offer `Add` or `Remove` for built-in OpenWork entries.

Daytona caveat:

- If the Den Web browser form or custom-protocol handoff fails only because of Daytona proxy origin behavior, record that as incomplete for the Den handoff step.
- You may bridge the desktop session with a direct Den API token to validate downstream desktop Marketplace sync, but the report must say the bridge was used.

## Flow 4: default Marketplace API proof

**Goal:** The backend, not desktop local catalog injection, owns the default
Marketplace entries.

Steps:

1. With the same signed-in org, call Den API `GET /v1/marketplaces?status=active&limit=100`.
2. Find `OpenWork Marketplace`.
3. Call `GET /v1/marketplaces/:id/resolved`.

Expected outcome:

- The API returns `OpenWork Marketplace`.
- Resolved plugins include the built-in OpenWork entries.
- Each built-in plugin has `extension.sourceFormat = openwork-builtin`.
- `OpenWork Browser` has an extension manifest with the `opencode-chrome-devtools` resource.

## Flow 5: assigned Marketplace plugin import

**Goal:** A normal assigned Marketplace plugin imports into the active desktop
workspace after Cloud sign-in.

Setup:

1. Use Den API to create a small test plugin such as `Daytona Starter Plugin`.
2. Add one config object, such as `Daytona Starter Skill`, to that plugin.
3. Attach the plugin to an assigned marketplace.

Steps:

1. Create or open a local desktop workspace.
2. Open Settings -> Marketplace.
3. Refresh the Marketplace list.
4. Open the test plugin card.
5. Click `Add`.
6. Open Settings -> Extensions -> My Extensions.
7. Inspect the workspace filesystem.

Expected outcome:

- The test plugin changes from `Add` to `Installed` in Marketplace.
- The test plugin appears in My Extensions as `Connected`.
- The expected file exists under `.opencode/skills/.../SKILL.md`.
- The imported file contains the source text from Den.
- The detail modal does not keep showing a stale `Add` action after install.

## Flow 6: chat handoff after provisioning

**Goal:** The user can move from provisioning into chat and actually use the
imported skill/plugin.

Steps:

1. Open the active workspace session view.
2. Confirm the composer is visible.
3. Type or set a prompt that asks the imported skill/plugin for a deterministic response.
4. Send it when the runtime is ready.

Expected outcome:

- `Run task` / composer send becomes available when opencode runtime is connected.
- The task is submitted without losing the imported plugin state.
- The response contains the deterministic output from the imported skill/plugin.

Latest Daytona proof:

- Created live plugin `Marketplace Runtime Probe` in the assigned `Anthropic-Compatible Plugins` marketplace.
- Imported it into workspace `Marketplace Use Test` and confirmed `.opencode/skills/marketplace-runtime-probe-plugin/marketplace-runtime-probe-skill/SKILL.md` materialized.
- Direct OpenCode runtime proof returned `MARKETPLACE_RUNTIME_PROBE_OK`.
- Desktop chat in workspace `Marketplace Runtime Chat` also returned `MARKETPLACE_RUNTIME_PROBE_OK`.

## Artifact evidence rules

- Every screenshot must be preceded by a native-window check that fails if `Authorize folder` is present.
- At least one representative screenshot must be visually inspected before publishing links.
- If a sandbox stops, artifact proxy URLs become stale. Restart the sandbox, restart the artifact server on `8090`, and publish fresh URLs.
- Do not claim a full pass from a recording that uses an auth bridge. Separate the verdict into Den handoff, desktop Marketplace sync, live plugin import, and chat/runtime.
- Do not claim a founder-ready demo from a run that mostly used invisible automation. Mark it as technical validation and record a separate click-by-click user journey.

## 8-star experience target

The current flow proves the cloud-provisioned Marketplace concept, but an
8-star founder/designer demo should feel like one continuous product journey:

1. Den sign-in loads without proxy/auth ambiguity and uses the same visual language as desktop.
2. Den explains in plain language: Marketplaces contain plugins; OpenWork Marketplace is included; org marketplaces appear after desktop sign-in.
3. The handoff page has one obvious primary action: `Open desktop app`, with a secondary `Copy sign-in code` fallback.
4. Desktop opens directly into a connected state or a clear auth-completion state, not a generic settings page.
5. Desktop shows a short success moment: `Connected to Acme Robotics` and `Marketplace synced`.
6. Marketplace is pre-populated without manual refresh, with `OpenWork Marketplace` grouped separately from org marketplaces.
7. Built-ins look first-party and ready, with `Built-in` status, no install/remove actions, and clear setup expectations.
8. A live org plugin can be added with one click, then immediately appears in My Extensions and the composer/tooling surface.
9. The user can send a task that uses the imported skill/plugin and gets a visible response.
10. The whole flow can be recorded without native pickers, hidden browser state, manual token injection, or terminal-only proof.

Pass/fail for the 8-star demo should be based on the human journey, not just API
state. If the user cannot understand what happened and why it matters from the
recording alone, the experience is not 8-star yet.

## Future: full server-owned extensions

This PR intentionally makes Den the source of discovery and assignment for
built-ins, but it does not move all built-in implementation code to Den. Den
stores and returns OpenWork extension manifests; the desktop still owns local
execution for first-party built-ins such as Browser, Computer Use, image
generation, Google Workspace, and Ollama.

To move the entire extension concept server-side in the future, we would need:

- A versioned extension package model, not just manifest projection: resources, UI contributions, tools, commands, MCP definitions, permissions, setup steps, and compatibility metadata.
- A trusted distribution and signing story so desktop can safely install or update extension code/resources from Den.
- A runtime boundary for extension execution: local-only, remote worker, or hybrid, with explicit capability grants and audit logs.
- A migration path for existing desktop built-ins so first-party code can be represented as Den-managed packages without breaking offline/local-first use.
- A desktop extension host that can render server-defined contribution points while preserving native/local affordances.
- Policy controls for admins: allow/deny extensions, pin versions, stage rollouts, require approval, and revoke compromised versions.
- Update and rollback semantics: how a workspace moves from extension version N to N+1, and how materialized `.opencode` files are reconciled.
- Observability: install status, resource materialization status, runtime health, and failure reasons visible in both Den and desktop.
- Offline behavior: built-ins and already-installed org extensions should keep working when Den is unreachable, while clearly showing sync state.
- Security review for remote code, secrets, OAuth providers, MCP endpoints, file writes, and cross-workspace data access.

The likely phased path is:

1. Keep this PR's model: Den owns Marketplace membership and manifests; desktop owns built-in execution.
2. Add explicit extension package/version records in Den for org plugins and first-party built-ins.
3. Teach desktop to install versioned Den packages into an extension host with signed resource manifests.
4. Move selected first-party built-ins from hardcoded desktop catalogs into signed first-party packages while keeping local fallback bundles.
5. Add admin rollout, policy, audit, and rollback controls before allowing arbitrary executable extension code.
