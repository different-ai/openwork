# opencode-openwork

Use OpenWork Cloud in [OpenCode](https://opencode.ai) 2. Sign in once; every time OpenCode starts it loads:

- your organization's **AI Gateway** models, with your gateway key
- **OpenWork MCP**: `openwork-cloud` (your organization's skills, plugins and connections) and each connection your admin made available in other apps (`openwork-direct-<name>-<id>`)

No OpenWork desktop app is needed.

## Requirements

This plugin needs **OpenCode V2** with the integration, provider and MCP plugin APIs; it is tested with **2.0.26**. OpenCode V1 and older V2 betas without those APIs are not supported. Check `opencode --version` (or `opencode2 --version` if that is your V2 executable). Installing the plugin does not install or upgrade OpenCode.

## Install

```sh
opencode plugin add opencode-openwork
```

This adds `opencode-openwork` to the `plugins` array in your global `~/.config/opencode/opencode.json`, keeping your other settings.

### Install from Git (unreleased changes)

To run the latest code from `dev` instead of the npm release, clone the plugin and point OpenCode at the folder:

```sh
git clone --depth 1 --filter=blob:none --sparse --branch dev \
  https://github.com/different-ai/openwork.git \
  "$HOME/.local/share/opencode/openwork-source"
git -C "$HOME/.local/share/opencode/openwork-source" sparse-checkout set packages/opencode-plugin packages/remote-sessions
```

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    { "package": "file:///absolute/path/to/home/.local/share/opencode/openwork-source/packages/opencode-plugin" }
  ]
}
```

Replace `/absolute/path/to/home` with your own home directory. OpenCode V2 loads the source entrypoint directly, so this needs no dependency install or build.

### Sign in yourself

The human, not the installation agent, runs this command and approves the browser prompt:

```sh
opencode auth login openwork --method browser --standalone
```

Use `opencode2` instead if that is your installed V2 executable. The plugin waits through token-poll rate limits, backing off and honoring `Retry-After` without opening a new authorization attempt. If the code expires, run login again.

If an old background service reports an incompatible protocol, ask before running `opencode service restart`: it may interrupt active sessions.

`opencode auth login openwork` offers two ways to sign in:

- **Browser** (default). OpenCode opens OpenWork in your browser. Sign in, pick your organization and approve; OpenCode finishes signing in on its own.
- **Code** (`--method code`), for SSH and machines without a browser. Open the link on any device and confirm the code shown in your terminal.

Inside OpenCode, `/connect` → **OpenWork Cloud** does the same.

### Copy-paste instructions for an installation agent

```text
Check which installed OpenCode executable is V2. This plugin needs OpenCode V2
(tested with 2.0.26); if it is unavailable, explain that requirement and stop.
Leave installed OpenCode versions unchanged.

Run `opencode plugin add opencode-openwork` with the V2 executable. Check that
the global ~/.config/opencode/opencode.json(c) now lists opencode-openwork in
its plugins array and that all existing settings are preserved.

Give me the browser-login command for the installed V2 executable:
opencode auth login openwork --method browser --standalone
(use opencode2 if that is its name). Do not run login or handle credentials.

Wait for me to confirm browser approval. Then verify auth list, OpenWork's
models and MCP connections. Ask permission before restarting a background
service. Report failed checks honestly; do not publish anything or set up CI.
```

## Check it

```sh
opencode auth list            # OpenWork Cloud: you@company.com · Your org
opencode models | grep ipr_   # AI Gateway models
opencode mcp list             # openwork-cloud, openwork-direct-…
```

Models and connections refresh in the background; an empty first list is not proof that sign-in failed. Allow initialization to finish and check again using the normal background service rather than repeatedly starting fresh `--standalone` discovery processes. Confirm authentication separately with `auth list`.

## Sign out or switch organization

```sh
opencode auth logout openwork
```

The plugin also ends the OpenWork session and removes the models and MCP servers it added. To use another organization, sign in again and pick it on the approval page.

## Options

```jsonc
// ~/.config/opencode/opencode.json
{
  "plugins": [
    {
      "package": "file:///absolute/path/to/home/.local/share/opencode/openwork-source/packages/opencode-plugin",
      "options": {
        "apiBaseUrl": "https://api.openworklabs.com", // self-hosted or enterprise OpenWork
        "providers": true,                            // false: no AI Gateway models
        "mcp": true,                                  // false: no OpenWork MCP servers
        "remoteSessions": false,                      // true: explicitly approve remote prompts here
        "label": "My OpenCode computer",               // optional remote target display name
        "refreshIntervalMs": 300000                   // how often to refresh (minimum 60000)
      }
    }
  ]
}
```

## Optional remote sessions

**Signing in does not approve this machine for remote work.** Remote sessions are off by default. Only set `"remoteSessions": true` yourself when you want OpenWork's remote-session tools (including Slack and MCP) to create sessions and send prompts in this OpenCode Location. Your organization must also enable **Remote session targets**; the plugin cannot enable that rollout.

The runner advertises only the directory where this plugin instance is loaded, with an opaque workspace ID and that Location's available native models. It uses the same native OpenCode host as your interactive work—no embedded OpenWork server, service discovery, local HTTP connection, or authentication override. Normal OpenCode permissions remain in effect. Permission and question waits are reported to the caller; answer them in OpenCode. The plugin never approves them for you.

- Set `remoteSessions` back to `false` and reload the plugin to withdraw local approval. Sign-out, credential expiry, account/organization changes, and plugin unload stop remote polling and native control. Already admitted native sessions are not deleted or silently interrupted.
- Runner health is inspectable through the controller's `inspectStatus()` and plugin storage at `remoteSessions/status/<directory hash>`. It records the last credentials, registration, inventory, recovery, or work failure phase without credentials, prompts, or provider exception text.
- Runner tokens renew in the background without clearing the durable delivery journal. Reconnecting reuses saved receipts and stable prompt IDs rather than creating or sending the same work twice. Interrupted creation is recovered by a deterministic native session ID; the returned session must match the original command metadata and approved directory before it is trusted.
- A process-safe lock permits only one runner for the same actual directory. A live or suspended process's lock is never stolen; a dead process's marker can be reclaimed. An unreadable or incomplete lock fails closed.
- **Transcript limitation:** OpenCode 2.0.26's plugin host exposes recent context after compaction, not full historical messages. Reads declare `historyScope: "context"`; unknown or compacted pagination cursors return an explicit error. Tool summaries and text are bounded and may be truncated.
- Stop checks the latest native user message before calling OpenCode's interrupt API. The native host does not expose an atomic message-ID-guarded interrupt, so do not concurrently steer a remotely controlled session from another client if strict turn isolation is required.

The published package bundles the shared remote-session core and has no runtime dependencies. Git source installs need both sparse-checkout directories shown above for remote sessions. An older sparse checkout still supports sign-in, models, and MCP while remote sessions are off; an opt-in missing the shared package reports an unavailable status in plugin storage at `remoteSessions/status` and logs recovery instructions without disabling those ordinary features.

## Desktop-managed providers (internal host integration)

The desktop server can load the same `server.ts` source entry (or the built
`dist/server.js`, keeping its adjacent chunks) with these plugin options:

```json
{
  "desktopSession": "http://127.0.0.1:1234/provider-session"
}
```

The managed v2 plugin owns Gateway inventory for the engine's entire lifetime.
The legacy materializer remains the owner only for v1; never run it alongside
the v2 plugin. No feature lookup or rollout option is needed.

The managed child receives a one-shot anonymous pipe on fd 3 containing JSON
`{endpoint, token}`. Only a nonsecret fd marker (`OPENWORK_PROVIDER_SESSION_FD=3`)
is in its environment: the capability is never in initial process environment,
arguments, files, plugin options, or config. The trusted plugin entrypoint consumes
and closes the pipe before setup. A frozen native CJS
broker shares the capability across Location-scoped ESM/source graphs and reloads,
with the credential retained only in its module closure; it signs requests only to
the bound endpoint. `OPENWORK_PROVIDER_SESSION_BROKER` contains only the absolute
path to that credential-free broker code (not a credential/config file). Reloads need no still-open credential descriptor.
The capability is scoped to catalog transport and ephemeral local inference, not
a Den session or reusable Gateway credential. `desktopSession` returns only
`{apiBaseUrl, identity, orgId, inferenceOrigin, inferenceKey}` or JSON `null` while
signed out. The opaque identity hash is stable across engine ports/capabilities
and changes with the account, org, or Den credential. **Both the Den bearer and
raw member `ow_gw_` key stay exclusively in the OpenWork server**, never in the
engine, including its other project plugins. Inventory connects return only the
`ow_local_catalog` placeholder. Public cached catalogs are rebound on publication
to the current loopback inference origin and identity-bound ephemeral `ow_local_`
key; neither loopback endpoints nor ephemeral keys are persisted in that cache.

The bridge accepts only GET usable-provider-list, per-provider-connect, and
inventory-event requests, each bound to the expected identity. For inference it
accepts only POST chat/completions, responses, messages, and Gemini generateContent
or streamGenerateContent routes (including v1/v1beta prefixes). It resolves the
current authorized provider connection for each inference request and supplies
the real Gateway bearer server-side. Old-identity/old-engine keys cannot authorize
another identity or bridge. Caller auth/org/cookie/Host headers are not forwarded;
semantic protocol headers and quota markers are preserved. Real inference JSON/SSE
is streamed with credential redaction across chunk boundaries; inventory SSE is
canonicalized to invalidations/heartbeats. Admin, MCP, arbitrary URLs, other
mutations, redirects and WebSocket upgrades are unsupported. This transport
supports HTTP inference only; native WebSocket routes must use HTTP fallback.
Only literal HTTP loopback addresses are accepted for the engine-facing endpoint.

This mode registers only providers: no MCP, standalone login, remote sessions,
or Den sign-out. It checks the local handoff every second and fetches Den
inventory on session changes, stream connection/reconnection, and
`inventory.changed` events. Account/org/token changes cancel and fence old
requests. Startup cache is scoped by a hash of the API URL, org, and session;
only public gateway inventory and a dummy credential are cached, never reusable
Den/Gateway keys, ephemeral inference keys, or the loopback capability. A feature-disabled stream `404` stops reconnection for that
session while preserving its last snapshot. Heartbeat stalls and transient
failures reconnect with bounded backoff. Locations in one engine share a single
session-scoped stream with reference-counted fanout; unloading one Location never
aborts the others. Failed inventory reconciliations retry with bounded backoff
until they converge, then stop (no inventory polling). Stream 401/403 and whole
inventory-list 403 clear that session's providers/cache and fence late requests;
an individual provider's connect 403 first refetches the inventory.

## How it works

- Sign-in uses OpenWork's device authorization. OpenCode stores the session in its own credential store (`~/.local/share/opencode/opencode.db`).
- On start, the plugin publishes the same account's last known models and servers, then refreshes from OpenWork in the background and every five minutes. It also subscribes to authenticated inventory events; each event/reconnect bypasses the 30-second shared cache. Standalone sign-in and periodic MCP refresh remain unchanged.
- AI Gateway models talk to `gateway.openworklabs.com` with your personal gateway key. MCP servers talk to OpenWork's MCP gateway (`/mcp/agent`) with a 7-day token that is renewed automatically.

Built for OpenCode 2 (`@opencode/plugin` 2.0.26).

## Releasing

Maintainers of the `different-ai-inc` npm organization release new versions:

1. Bump `version` in `package.json` and merge.
2. Push a tag `opencode-plugin-v<version>`. The [Publish OpenCode plugin](../../.github/workflows/publish-opencode-plugin.yml) workflow tests, builds, and stages the version with signed provenance. No npm token is stored in GitHub; npm trusts that workflow file.
3. Approve the staged version with 2FA on [npmjs.com](https://www.npmjs.com/package/opencode-openwork) or with `npm stage list opencode-openwork` and `npm stage approve <id>`. It is not installable until then.
