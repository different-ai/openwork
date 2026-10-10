---
name: reproduce-chat-states
description: Reproduce a known chat state in the running desktop on demand (model provider errors and retries, Code Mode and Den script failures, parallel tool steps, app creation, sequential commands) and check how it renders. Use when fixing or designing chat error, retry, tool-step or app-card UI.
---

# Reproduce chat states

Each state below fires in a **new session** of the running desktop window through `drive-desktop-cdp`. Provider states also need `fake-model-faults` set up.

```bash
export CDP_URL=http://127.0.0.1:<cdp port>
R=.opencode/skills/reproduce-chat-states/scripts/repro.mjs
C=.opencode/skills/drive-desktop-cdp/scripts/cdp.mjs
node $R provider-refused && node $C wait-idle && node $C shot /tmp/refused.png
```

Run `node $R` with no argument for the list. Pass a second argument (or set `GATEWAY_MODEL`) to change the real model used for the non-fault states.

## States and what to look at

| State | Fires | Check |
|---|---|---|
| `provider-refused`, `provider-dns`, `provider-reset` | engine transport error, retried, then final | one error per turn, plain title, raw text only behind the details icon |
| `provider-retrying` | same as reset; watch the first 30s | "Reconnecting to the model" with attempt progress, no raw text |
| `provider-midstream`, `provider-stall` | cut or stalled reply | interrupted reply keeps partial text |
| `http-429`, `http-5xx`, `http-401`, `http-402` | HTTP error bodies | the matching plain-language title and next action |
| `codemode-wrong-tool` | `tools.search(...)` in Code Mode | a recovered step must not read as a hard failure |
| `den-script-rejected` | Den script with `.then` | Den's real reason in details, not a generic placeholder |
| `den-script-service-failure` | provider op fails inside a Den script | "Script on OpenWork Cloud failed", reason behind the icon |
| `den-script-parallel` | 20 Slack calls in one script | one readable group, collapsed until opened |
| `parallel-searches` | 10 Exa searches plus Slack | clean service names and logos, no routing ids |
| `app-create` | MCP app build with retries | one card per app that advances through its steps |
| `sequential-commands` | 5 separate bash calls | the chat does not jump (see `measure-chat-flicker`) |

## Reading what happened

Stored v2 history shows exactly what the engine recorded (useful when a step looks wrong):

```bash
sqlite3 ~/.config/openwork/opencode-v2/state/opencode.db \
  "select type, substr(data,1,400) from session_message where session_id='<ses_…>' order by seq"
```

For a step inside Code Mode, check `state.metadata.toolCalls` and `state.metadata.openworkMcpResults` on the `execute` part.
