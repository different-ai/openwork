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
   pnpm --filter @openwork/desktop dev
   ```
2. Wait ~20s, then verify CDP:
   ```
   browser_list({ browser_url: "http://127.0.0.1:9223" })
   ```
   You should see the OpenWork target.
3. Enable control mode:
   ```
   browser_eval({ browser_url: CDP_URL, target_id: APP_TARGET,
     expression: "window.__openworkControl.setEnabled(true); 'ok'" })
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
- No stale MCP keys (`openwork-browser`, `chrome`, `chrome-devtools`,
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
     expression: "window.__openworkControl.execute('session.create_task')" })
   ```
2. Type and send the prompt:
   ```
   browser_eval({ browser_url: CDP_URL, target_id: APP_TARGET,
     expression: `(async () => {
       const ctrl = window.__openworkControl;
       await ctrl.execute('composer.set_text', { text: 'Use the OpenWork Browser extension to navigate to https://example.com and tell me the page title' });
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
2. Send: "Use the OpenWork Browser extension to go to https://www.google.com,
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
- "OpenWork Browser" is visible with a name and description.
- "Chrome" is not visible as an OpenWork extension.

Known regressions this catches:
- Extension catalog not loaded.
- `isOpenWorkExtensionEnabled` filtering incorrectly.

## Flow 5 — Extension chip inserts composerPrompt

**Why**: Clicking an extension in the menu must inject its `composerPrompt`
into the composer text.

Steps:
1. With the Extensions menu open, click the "OpenWork Browser" entry.
2. Check the composer text.

Pass criteria:
- Composer contains "Use the OpenWork Browser extension to".
- The tool menu closed.

Known regressions this catches:
- `applyExtensionSelection` not calling `onDraftChange`.
- Lexical `SyncPlugin` not picking up the draft change.

## Flow 6 — Extension toggle hides from composer

**Why**: Disabling an extension via the Extensions panel must remove it from
the composer menu.

Steps:
1. Disable OpenWork Browser:
   ```
   browser_eval({ browser_url: CDP_URL, target_id: APP_TARGET,
     expression: `(() => {
       localStorage.setItem('openwork.extension.disabled.openwork-browser', '1');
       window.dispatchEvent(new CustomEvent('openwork:extension-state-changed', {
         detail: { id: 'openwork-browser', enabled: false }
       }));
       return 'disabled';
     })()` })
   ```
2. Open the Extensions menu and count extensions.
3. Re-enable:
   ```
   browser_eval({ browser_url: CDP_URL, target_id: APP_TARGET,
     expression: `(() => {
       localStorage.removeItem('openwork.extension.disabled.openwork-browser');
       window.dispatchEvent(new CustomEvent('openwork:extension-state-changed', {
         detail: { id: 'openwork-browser', enabled: true }
       }));
       return 'enabled';
     })()` })
   ```
4. Re-open Extensions menu and count.

Pass criteria:
- After disabling: OpenWork Browser is NOT in the Extensions menu.
- After re-enabling: OpenWork Browser IS in the Extensions menu.
- `localStorage` key `openwork.extension.disabled.openwork-browser` is `"1"`
  when disabled, absent when enabled.

Known regressions this catches:
- Toggle state not persisted to localStorage.
- Custom event not triggering re-render.

## Flow 7 — Stale MCP migration

**Why**: Workspaces from the pre-extension architecture have dead MCP entries
(`openwork-browser`, `chrome`) that must be cleaned up on activation.

Steps:
1. Write a stale config to the workspace `opencode.jsonc`:
   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "default_agent": "openwork",
     "mcp": {
       "openwork-browser": { "type": "remote", "url": "http://127.0.0.1:59674/mcp" },
       "chrome": { "type": "remote", "url": "http://127.0.0.1:59675/mcp" },
       "openwork-ui": { "type": "remote", "url": "http://127.0.0.1:59673/mcp" }
     }
   }
   ```
2. Restart the dev instance.
3. Read the migrated `opencode.jsonc`.

Pass criteria:
- `openwork-browser` MCP entry removed.
- `chrome` MCP entry removed.
- `openwork-ui` MCP entry preserved (not a legacy browser MCP).
- `default_agent: "openwork"` preserved.
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
2. Open the "OpenWork Browser" detail modal and click `Hide`.
3. Confirm "OpenWork Browser" disappears from the normal Extensions catalog.
4. Open the composer tool menu -> Extensions.
5. Confirm "OpenWork Browser" is not listed.
6. Return to Settings -> Extensions and click `Show hidden`.
7. Confirm "OpenWork Browser" reappears with a hidden badge.
8. Open its detail modal and click `Show`.

Pass criteria:
- Hidden state is persisted in localStorage under
  `openwork.extension.hidden.openwork-browser`.
- Normal Extensions catalog excludes the hidden card.
- Composer Extensions excludes the hidden card.
- `Show hidden` reveals the card and allows restoring visibility.

Known regressions this catches:
- Hidden extensions still appearing in composer.
- Hidden state not re-rendering after the custom extension-state event.
- `Show hidden` acting like a destructive uninstall instead of a reversible view preference.

## Flow 9 — Cloud marketplace appears in Extensions Marketplace

**Why**: Organization marketplaces are now reached from Extensions ->
Marketplace, not Cloud settings. This flow verifies the marketplace import path
still works from the new IA.

Steps:
1. Sign in to OpenWork Cloud with an org that has a marketplace plugin.
2. Open Settings -> Extensions.
3. Click `Marketplace`.
4. Verify marketplace packages are visible in one searchable list.
5. Click `Refresh` in the Marketplace view.
6. Add an available package.

Pass criteria:
- Cloud sidebar does not show a separate Marketplace item.
- The marketplace package is visible from Settings -> Extensions -> Marketplace.
- Add succeeds and reports the number of imported files.
- The imported package appears in My Extensions.
- Existing Cloud Account, Providers, and Workers settings remain available.

Known regressions this catches:
- Marketplace still only reachable through Cloud settings.
- Marketplace import losing the active org context after moving into Extensions.
- Extensions refresh not refreshing cloud marketplace data.
