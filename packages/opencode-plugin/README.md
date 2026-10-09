# opencode-openwork

Use OpenWork Cloud in [OpenCode](https://opencode.ai) 2. Sign in once; every time OpenCode starts it loads:

- your organization's **AI Gateway** models, with your gateway key
- **OpenWork MCP**: `openwork-cloud` (your organization's skills, plugins and connections) and each connection your admin made available in other apps (`openwork-direct-<name>-<id>`)

No OpenWork desktop app is needed.

## Install

```sh
opencode plugin add opencode-openwork
opencode auth login openwork
```

OpenCode opens OpenWork in your browser. Sign in, pick your organization and approve; OpenCode finishes signing in on its own.

On SSH or a machine without a browser, open the printed link on any device and confirm the code shown in your terminal. The terminal finishes on its own; the browser tab can be closed.

Inside OpenCode, `/connect` → **OpenWork Cloud** does the same.

## Check it

```sh
opencode auth list            # OpenWork Cloud: you@company.com · Your org
opencode models | grep ipr_   # AI Gateway models
opencode mcp list             # openwork-cloud, openwork-direct-…
```

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
      "package": "opencode-openwork",
      "options": {
        "apiBaseUrl": "https://api.openworklabs.com", // self-hosted or enterprise OpenWork
        "providers": true,                            // false: no AI Gateway models
        "mcp": true,                                  // false: no OpenWork MCP servers
        "refreshIntervalMs": 300000                   // how often to refresh (minimum 60000)
      }
    }
  ]
}
```

## How it works

- Sign-in uses OpenWork's device authorization. OpenCode stores the session in its own credential store (`~/.local/share/opencode/opencode.db`).
- On start, the plugin publishes the last known models and servers straight away, then refreshes from OpenWork in the background and every five minutes.
- AI Gateway models talk to `gateway.openworklabs.com` with your personal gateway key. MCP servers talk to OpenWork's MCP gateway (`/mcp/agent`) with a 7-day token that is renewed automatically.

Built for OpenCode 2 (`@opencode/plugin` 2.0.26).
