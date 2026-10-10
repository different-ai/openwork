# opencode-openwork

Use OpenWork Cloud in [OpenCode](https://opencode.ai) 2. Sign in once; every time OpenCode starts it loads:

- your organization's **AI Gateway** models, with your gateway key
- **OpenWork MCP**: `openwork-cloud` (your organization's skills, plugins and connections) and each connection your admin made available in other apps (`openwork-direct-<name>-<id>`)

No OpenWork desktop app is needed.

## Requirements

This plugin needs **OpenCode V2** with the integration, provider and MCP plugin APIs; it is tested with **2.0.26**. OpenCode V1 and older V2 betas without those APIs are not supported. Check `opencode --version` (or `opencode2 --version` if that is your V2 executable). Installing the plugin does not install or upgrade OpenCode.

## Install from Git

```sh
git clone --depth 1 --filter=blob:none --sparse --branch dev \
  https://github.com/different-ai/openwork.git \
  "$HOME/.local/share/opencode/openwork-source"
git -C "$HOME/.local/share/opencode/openwork-source" sparse-checkout set packages/opencode-plugin
```

Add the plugin to the `plugins` array in your existing global `~/.config/opencode/opencode.json(c)`, preserving all other settings:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    { "package": "file:///absolute/path/to/home/.local/share/opencode/openwork-source/packages/opencode-plugin" }
  ]
}
```

Replace `/absolute/path/to/home` with your own home directory; do not copy another person's path. OpenCode V2 loads the source entrypoint directly, so this Git installation does not need a dependency install or build.

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

Clone https://github.com/different-ai/openwork, branch dev, into
~/.local/share/opencode/openwork-source with a sparse checkout of
packages/opencode-plugin. If that directory already exists, inspect it first
and preserve any local changes.

Add the plugin's absolute file:// directory URL to the plugins array in the
existing global ~/.config/opencode/opencode.json(c). Preserve all existing
settings. Use Git only for the plugin; no dependency install or build is needed.

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
