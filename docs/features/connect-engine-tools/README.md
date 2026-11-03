# A tool for each action in OpenWork's engine

Feature `connectEngineTools` (cloud and self-hosted, off by default). Author: `reachjalil`.

## What changes

OpenWork Desktop, Web and automation runs talk to OpenWork Connect through the OpenCode v2 engine. That engine
already searches MCP tools itself: its Code Mode lists a catalog and ranks `search()` results by the words in each
tool's name, description and parameters. Without this feature the engine sees only Connect's
`search_capabilities` and `execute_capability`, so finding a Gmail or Linear action means searching inside a search.

With it on, Den serves OpenWork's engine one tool per action on the same `openwork-cloud` server:

| The engine sees | For |
| --- | --- |
| `linear_list_issues`, `google_workspace_…` | each action of each connected service (Den's `linear.list_issues`) |
| `run-workflow_<name>`, `open-app_<name>`, `remote-session_<action>` | Workflows, Apps and remote sessions |
| `connection_status` | the sign-in card for a service the member has not connected yet |
| `search_capabilities`, `execute_capability` | OpenWork's own operations (Plugins, marketplaces, connection settings, My agent) and skills, which have no tool of their own |

Search quality, since the engine's ranking is plain keywords:

- **Directory.** The instructions list the member's connected services by the prefix of their tool names, ready ones
  first, then the ones not connected yet. The catalog groups every tool under one server, so this is where the model
  learns which services exist without searching.
- **Related words.** Each tool description ends with the other names Den's own search knows for the things it
  mentions (`ticket` for an issue tool, `meeting` for a calendar event), so `search({ query: "create ticket" })` finds
  `create_issue`. Only names for things are added, never verbs.
- Capability search leaves out everything listed as a tool, so there is one way to reach each action. An explicit
  connect request (`intent: "connect"`) still finds the connection and its card.

Everything still runs through `execute_capability`'s executor: grants, tool policy, scopes, audit and usage are
unchanged. Sign-in cards, Apps and labels keep working because the tools stay on `openwork-cloud`.

## Who gets it

Only OpenWork's own engine: a request that reports OpenCode's client name and holds a token Den minted for OpenWork
(`/v1/mcp/token`, or a headless run token). Claude Code, standalone OpenCode, Cursor, ChatGPT and claude.ai follow
`connectStandardTools` as before. A Desktop on an older release gets the same tools; its instructions already handle
either list.

## Turning it on and off

Turn `connectEngineTools` on for an organization in `/admin` (Features, or the organization's row). Off, OpenWork's
engine gets `search_capabilities` and `execute_capability` again on its next request; nothing is stored. A request
with `?tools=search` keeps capability search while the flag is on.

What to watch: tool calls from Desktop with the `connector_tool/agent` usage source, `unknown_capability` errors
from `execute_capability` (the model looking for an action through search), and how often the engine calls
`search()` before a Connect tool.

Code: `ee/apps/den-api/src/mcp/engine-tool-view.ts` (what the engine gets on top of the full view),
`connect-tool-view.ts` (who gets it), `agent.ts` and `agent-server.ts` (tools and instructions). Tests:
`ee/apps/den-api/test/engine-tool-view.test.ts` and `test/api/connect-full-tools.api.test.ts`.
