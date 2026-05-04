# MCP UI Control Profile

Status: draft

OpenWork uses MCP as the public integration shape for app and server control. The
UI Control profile is a convention layered on top of normal MCP tools so any MCP
client can discover app state and execute semantic UI actions without scraping
DOM nodes, coordinates, or native accessibility trees.

## Goals

- Make standalone control clients such as HandsFree MCP clients that can control
  any configured MCP-compatible app or service.
- Let OpenWork expose product/app actions through MCP instead of a private local
  bridge.
- Keep UI automation semantic: actions like `composer.send`, not `click x y`.
- Preserve escape hatches: CDP, WebDriver BiDi, and native accessibility remain
  fallback transports when an app has no semantic MCP surface.

## Profile tools

MCP servers that want to expose controllable UI should provide these tools.

### `ui.snapshot`

Returns the app's current semantic state.

Suggested output:

```json
{
  "app": { "id": "openwork", "name": "OpenWork", "version": "0.13.3" },
  "route": "session",
  "title": "Current session",
  "selection": { "sessionId": "ses_123" },
  "summary": "Session page with composer ready",
  "actions": ["session.read_transcript", "composer.set_text", "composer.send"]
}
```

### `ui.list_actions`

Returns currently available semantic actions.

Each action should include:

```json
{
  "id": "composer.set_text",
  "label": "Type into the composer",
  "description": "Replace the current session draft with supplied text.",
  "inputSchema": {
    "type": "object",
    "properties": { "text": { "type": "string" } },
    "required": ["text"]
  },
  "sideEffect": "draft",
  "requiresConfirmation": false,
  "enabled": true
}
```

Recommended `sideEffect` values:

- `read`: no visible change
- `navigation`: route/focus change
- `draft`: changes unsent input only
- `mutation`: sends/runs/changes durable state
- `destructive`: deletes or irreversibly changes state
- `external`: opens another app, network destination, or OS surface

### `ui.execute_action`

Executes one action returned by `ui.list_actions`.

Input:

```json
{
  "actionId": "composer.set_text",
    "args": { "text": "Hello from HandsFree" },
  "confirmed": false
}
```

Output:

```json
{
  "ok": true,
  "actionId": "composer.set_text",
  "result": { "draftLength": 16 }
}
```

Destructive actions should require `confirmed: true` or return an error that
explains the required confirmation.

## Generic MCP client behavior in HandsFree

HandsFree treats MCP as the primary app-integration layer.

HandsFree-level Realtime tools:

- `mcp_list_servers`: enumerate configured MCP servers.
- `mcp_list_tools`: inspect tools on a selected MCP server.
- `mcp_call_tool`: call any MCP tool by server/tool name.

HandsFree reads MCP server definitions from its local settings file under Electron
`userData`:

```json
{
  "mcpServers": {
    "example-stdio": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-sequential-thinking"]
    },
    "example-http": {
      "type": "http",
      "url": "http://127.0.0.1:8787/mcp",
      "headers": { "Authorization": "Bearer local-token" }
    }
  }
}
```

When a server implements this profile, HandsFree should prefer:

1. `ui.snapshot`
2. `ui.list_actions`
3. `ui.execute_action`

over OS typing, keyboard shortcuts, CDP, or accessibility fallbacks.

## OpenWork migration path

1. Keep `window.__openworkControl` as the app-local control registry.
2. Expose that registry through an OpenWork MCP server using this profile.
3. Update HandsFree to connect to the OpenWork MCP server like any other MCP server.
4. Keep the local HTTP bridge private to the OpenWork MCP server implementation.
