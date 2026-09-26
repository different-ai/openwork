---
name: connect-openwork-mcp
description: Connect the OpenWork MCP Gateway (https://api.openworklabs.com/mcp/agent) to Claude Code, Codex, Gemini CLI, Cursor, VS Code, Claude Desktop, or ChatGPT so the agent can use the user's OpenWork organization skills, plugins, and connections.
---

# Connect the OpenWork MCP Gateway

Server URL: `https://api.openworklabs.com/mcp/agent`
Transport: Streamable HTTP. Auth: OAuth (PKCE, dynamic client registration); the client opens a browser for sign-in. No API key is needed.

The user needs an OpenWork Cloud account. If they don't have one, send them to https://app.openworklabs.com?mode=sign-up first.

## 1. Add the server

Use the command for the client you are running in. If an `openwork` entry already exists, don't add a duplicate; sign in with the existing one.

Claude Code:

```sh
claude mcp add --transport http openwork https://api.openworklabs.com/mcp/agent
# add `-s user` to make it available in every project
```

Codex:

```sh
codex mcp add openwork --url https://api.openworklabs.com/mcp/agent
codex mcp login openwork
```

Gemini CLI:

```sh
gemini mcp add --transport http openwork https://api.openworklabs.com/mcp/agent
```

Cursor, VS Code, Claude Desktop, ChatGPT, Windsurf, Zed: add `https://api.openworklabs.com/mcp/agent` as a remote MCP server. Per-client steps: https://openworklabs.com/docs/start-here/connect-openwork-mcp

## 2. Sign in

- Claude Code: run `/mcp`, select `openwork`, and authenticate.
- Codex: `codex mcp login openwork` opens the browser.
- Gemini CLI: run `/mcp auth openwork`.

The user signs in and picks their organization. The organization is pinned to the token; to switch, log out of the `openwork` server and sign in again.

## 3. Verify

1. `claude mcp list` (or the client's equivalent) shows `openwork`.
2. Restart the agent session so the new tools load.
3. The agent has the `search_capabilities` and `execute_capability` tools.
4. Ask: "Which OpenWork organization am I connected to?"

Don't claim the connection works until step 3 passes.

## If it fails

- 401 or `invalid_grant`: log out of `openwork` in the client and sign in again.
- Self-hosted OpenWork: use your own Den API origin, for example `https://api.<your-den-web-host>/mcp/agent`.
- Reference: https://openworklabs.com/docs/cloud/run-in-the-cloud/cloud-mcp
