# Browser extension flows

End-to-end scenarios that verify the browser extension system: the
`opencode-chrome-devtools` plugin integration, composer extension chips,
Extensions panel, and the stale MCP migration path.

Run these before shipping changes that touch:

- `apps/server/src/workspace-init.ts`
- `apps/server/src/embedded.ts`
- `apps/app/src/app/constants.ts` (extension catalog)
- `apps/app/src/react-app/domains/settings/browser-extension-config.tsx`
- `apps/app/src/react-app/domains/settings/extension-state.ts`
- `apps/app/src/react-app/domains/settings/pages/extensions-view.tsx`
- `apps/app/src/react-app/domains/settings/pages/cloud-marketplaces-view.tsx`
- `apps/app/src/react-app/domains/session/surface/composer/composer.tsx`
- `apps/app/src/react-app/domains/session/settings/extensions-pane-slot.tsx`
- `apps/desktop/electron/main.mjs` (CDP port, browser panel)

## Preflight

1. Start the dev app (CDP auto-exposes on port 9223):
   ```bash
   pnpm --filter @micx/desktop dev
   ```
2. Wait ~20s, then verify CDP:
   ```
   browser_list({ browser_url: "http://127.0.0.1:9223" })
   ```
   You should see the Micx target.
3. Enable control mode:
   ```
   browser_eval({ browser_url: CDP_URL, target_id: APP_TARGET,
     expression: "window.__micxControl.setEnabled(true); 'ok'" })
   ```

## Flow 1 — Plugin is loaded and browser tools exist

**Why**: Without the `opencode-chrome-devtools` plugin in the workspace
`opencode.jsonc`, browser tools don't exist and the agent falls back to
`curl`/`webfetch`.

Steps:
1. Read the workspace `opencode.jsonc`:
   ```
   browser_eval({ browser_url: CDP_URL, target_id: APP_TARGET,
     expression: "fetch('/workspace/' + location.hash.split('/')[2] + '/opencode-config').then(r => r.text())" })
   ```
   Or check the file directly on disk.
2. Confirm `"plugin"` array contains `"opencode-chrome-devtools"`.

Pass criteria:
- `opencode.jsonc` has `"plugin": ["opencode-chrome-devtools"]`.
- No stale MCP keys (`micx-browser`, `chrome`, `chrome-devtools`,
  `control-chrome`) exist in the `mcp` section.

Known regressions this catches:
- Plugin not declared in workspace config → browser tools unavailable.
- Stale MCP entries from pre-extension architecture → noisy connection errors.

## Flow 2 — Built-in browser navigates via correct tools

**Why**: The agent must use `browser_navigate` (from the plugin), not
`curl`/`webfetch`, when asked to browse. The built-in browser panel must
visibly navigate.

Steps:
1. Create a new session:
   ```
   browser_eval({ browser_url: CDP_URL, target_id: APP_TARGET,
     expression: "window.__micxControl.execute('session.create_task')" })
   ```
2. Type and send the prompt:
   ```
   browser_eval({ browser_url: CDP_URL, target_id: APP_TARGET,
     expression: `(async () => {
       const ctrl = window.__micxControl;
       await ctrl.execute('composer.set_text', { text: 'Use the Micx Browser extension to navigate to https://example.com and tell me the page title' });
       await new Promise(r => setTimeout(r, 500));
       return JSON.stringify(await ctrl.execute('composer.send'));
     })()` })
   ```
3. Wait 30s for the task to complete.
4. Take a screenshot and check the transcript.

Pass criteria:
- The transcript shows `browser list` and `browser navigate` tool calls
  (not `webfetch`, not `bash`/`curl`).
- Tool calls include `"browser_url": "http://127.0.0.1:9223"`.
- The assistant response contains "Example Domain".
- The browser panel (right side) shows example.com.
- No raw `browser_url` or system instructions visible in the user message.

Known regressions this catches:
- Agent using `webfetch`/`curl` instead of browser tools.
- Wrong `browser_url` port (9222 vs 9223).
- Plugin loaded but no CDP endpoint available.

## Flow 3 — Browser interaction (navigate + fill + snapshot)

**Why**: Multi-step browser interactions must work: navigate, fill search,
read results.

Steps:
1. Create a new session.
2. Send: "Use the Micx Browser extension to go to https://www.google.com,
   search for 'opencode ai', and tell me the first result title"
3. Wait 60s for the multi-step task.
4. Check the transcript for tool calls.

Pass criteria:
- Transcript shows `browser_list`, `browser_navigate`, `browser_snapshot`,
  `browser_fill`, and `browser_eval` tool calls.
- All tool calls use `"browser_url": "http://127.0.0.1:9223"`.
- The assistant reports a search result title.

Known regressions this catches:
- Snapshot/fill/eval tools failing to connect to CDP.
- Agent not using the correct `target_id`.

## Flow 4 — Composer Extensions menu shows all extensions

**Why**: The Extensions section in the composer tool menu must list all
enabled extensions from the catalog.

Steps:
1. Open the tool menu:
   ```
   browser_eval({ browser_url: CDP_URL, target_id: APP_TARGET,
     expression: `(() => {
       const btn = Array.from(document.querySelectorAll('button')).find(b => b.title === 'Commands, skills, and MCPs');
       if (btn) { btn.click(); return 'opened'; }
       return 'not found';
     })()` })
   ```
2. Click the Extensions tab:
   ```
   browser_eval({ browser_url: CDP_URL, target_id: APP_TARGET,
     expression: `(() => {
       const tabs = document.querySelectorAll('button');
       for (let i = 0; i < tabs.length; i++) {
         if (tabs[i].textContent.trim() === 'Extensions') { tabs[i].click(); return 'clicked'; }
       }
       return 'not found';
     })()` })
   ```
3. Count visible extensions.

Pass criteria:
- "Micx Browser" is visible with a name and description.
- "Chrome" is not visible as an Micx extension.

Known regressions this catches:
- Extension catalog not loaded.
- `isMicxExtensionEnabled` filtering incorrectly.

## Flow 5 — Extension chip inserts composerPrompt

**Why**: Clicking an extension in the menu must inject its `composerPrompt`
into the composer text.

Steps:
1. With the Extensions menu open, click the "Micx Browser" entry.
2. Check the composer text.

Pass criteria:
- Composer contains "Use the Micx Browser extension to".
- The tool menu closed.

Known regressions this catches:
- `applyExtensionSelection` not calling `onDraftChange`.
- Lexical `SyncPlugin` not picking up the draft change.

## Flow 6 — Extension toggle hides from composer

**Why**: Disabling an extension via the Extensions panel must remove it from
the composer menu.

Steps:
1. Disable Micx Browser:
   ```
   browser_eval({ browser_url: CDP_URL, target_id: APP_TARGET,
     expression: `(() => {
       localStorage.setItem('micx.extension.disabled.micx-browser', '1');
       window.dispatchEvent(new CustomEvent('micx:extension-state-changed', {
         detail: { id: 'micx-browser', enabled: false }
       }));
       return 'disabled';
     })()` })
   ```
2. Open the Extensions menu and count extensions.
3. Re-enable:
   ```
   browser_eval({ browser_url: CDP_URL, target_id: APP_TARGET,
     expression: `(() => {
       localStorage.removeItem('micx.extension.disabled.micx-browser');
       window.dispatchEvent(new CustomEvent('micx:extension-state-changed', {
         detail: { id: 'micx-browser', enabled: true }
       }));
       return 'enabled';
     })()` })
   ```
4. Re-open Extensions menu and count.

Pass criteria:
- After disabling: Micx Browser is NOT in the Extensions menu.
- After re-enabling: Micx Browser IS in the Extensions menu.
- `localStorage` key `micx.extension.disabled.micx-browser` is `"1"`
  when disabled, absent when enabled.

Known regressions this catches:
- Toggle state not persisted to localStorage.
- Custom event not triggering re-render.

## Flow 7 — Stale MCP migration

**Why**: Workspaces from the pre-extension architecture have dead MCP entries
(`micx-browser`, `chrome`) that must be cleaned up on activation.

Steps:
1. Write a stale config to the workspace `opencode.jsonc`:
   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "default_agent": "micx",
     "mcp": {
       "micx-browser": { "type": "remote", "url": "http://127.0.0.1:59674/mcp" },
       "chrome": { "type": "remote", "url": "http://127.0.0.1:59675/mcp" },
       "micx-ui": { "type": "remote", "url": "http://127.0.0.1:59673/mcp" }
     }
   }
   ```
2. Restart the dev instance.
3. Read the migrated `opencode.jsonc`.

Pass criteria:
- `micx-browser` MCP entry removed.
- `chrome` MCP entry removed.
- `micx-ui` MCP entry preserved (not a legacy browser MCP).
- `default_agent: "micx"` preserved.
- `plugin: ["opencode-chrome-devtools"]` added.

Known regressions this catches:
- Stale MCPs causing connection errors on startup.
- Migration clobbering non-browser MCP entries.
- Migration clobbering `default_agent` or other top-level keys.

## Flow 8 — Hidden extensions stay out of normal UI and composer

**Why**: The Extensions pane now supports a Finder-style hidden view. Hidden
items should disappear from the normal catalog and composer menu, then reappear
when `Show hidden` is enabled.

Steps:
1. Open Settings -> Extensions.
2. Open the "Micx Browser" detail modal and click `Hide`.
3. Confirm "Micx Browser" disappears from the normal Extensions catalog.
4. Open the composer tool menu -> Extensions.
5. Confirm "Micx Browser" is not listed.
6. Return to Settings -> Extensions and click `Show hidden`.
7. Confirm "Micx Browser" reappears with a hidden badge.
8. Open its detail modal and click `Show`.

Pass criteria:
- Hidden state is persisted in localStorage under
  `micx.extension.hidden.micx-browser`.
- Normal Extensions catalog excludes the hidden card.
- Composer Extensions excludes the hidden card.
- `Show hidden` reveals the card and allows restoring visibility.

Known regressions this catches:
- Hidden extensions still appearing in composer.
- Hidden state not re-rendering after the custom extension-state event.
- `Show hidden` acting like a destructive uninstall instead of a reversible view preference.

## Flow 9 — Organization marketplace is Connect-only

**Why**: Organization marketplace extensions now run through Micx Connect,
not local marketplace installs. This flow verifies cloud delivery stays visible
without exposing the retired Add/import path.

Steps:
1. Sign in to Micx Cloud with an org that has a marketplace plugin.
2. Open Settings -> Connect and verify the org extension appears under From your organization.
3. Open Settings -> Marketplace and verify the same package says `Runs in cloud`.
4. Confirm no `Add`, `Install`, or `Update` action is shown for the org package.
5. Open Settings -> Extensions -> Marketplace.
6. Confirm the org package is absent there.

Pass criteria:
- The marketplace package is visible in Connect as organization cloud content.
- The organization Marketplace presents the package as cloud-active.
- No local Add/Install/Update action is available for the org package.
- Extensions Marketplace stays local-only and does not list the org package.
- Existing Cloud Account, Providers, and Workers settings remain available.

Known regressions this catches:
- Org marketplace packages leaking back into local Extensions.
- The retired local marketplace import path reappearing.
- Connect delivery losing the active org context.
