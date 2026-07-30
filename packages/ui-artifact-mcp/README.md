# OpenWork UI Artifact MCP

Deterministic local MCP server for developing chat-native OpenWork UI artifacts
without provider credentials or external data.

It is a real stateful stdio MCP and exposes exactly two tools:

- `search_artifacts` ranks the enabled artifact catalog from a user query and
  optional triggering tool metadata.
- `use_artifact` validates the exact artifact schema/version/digest returned by
  search, renders it, and retains mock instance state for the server process.
  It also applies explicit revision-safe approval or rejection decisions.

The mock catalog currently includes:

- `workspace.brief`
- `calendar.view`
- `widgets.collection`
- `communication.thread`
- `mail.inbox`
- `work.attention`
- `work.approvals`

All examples are visibly marked as mock data.

`calendar.view` is one stable artifact contract with `day`, `agenda`, and
`week` presentation variants. `widgets.collection` accepts a list that can
combine metric, progress, status, balance, and date widgets in grid, strip, or
stack layouts.

The production OpenWork Cloud surface still exposes only
`search_capabilities` and `execute_capability`. The same catalog is available
there as the virtual capabilities `openwork.ui_artifacts.search` and
`openwork.ui_artifacts.use`. Successful ordinary `execute_capability` calls
may return a bounded `uiArtifactSuggestions` receipt pointing to the virtual
search capability. This keeps automatic suggestions independent of OpenCode
or any other specific agent engine.

## Run locally

```bash
pnpm --filter @openwork/ui-artifact-mcp build
```

Or start the TypeScript server directly while developing:

```bash
pnpm --filter @openwork/ui-artifact-mcp dev
```

Add the built server to the worktree's `opencode.json`:

```json
{
  "mcp": {
    "ui-artifacts-demo": {
      "type": "local",
      "command": [
        "node",
        "/absolute/path/to/openwork/packages/ui-artifact-mcp/dist/cli.js"
      ],
      "enabled": true
    }
  }
}
```

Enable **UI artifacts (Alpha)** in OpenWork Settings → Preferences, then start a
new chat with:

```text
Use ui-artifacts-demo_search_artifacts to find a workspace brief, then call
ui-artifacts-demo_use_artifact with its exact example arguments. Briefly tell
me what the rendered artifact shows.
```

The generic tool view remains the fallback when the alpha preference is off,
the selected artifact kind is disabled, or the returned envelope fails schema
validation.

## Contract behavior

- Initial render calls are idempotent. A repeated render returns the retained
  current revision instead of resetting the fixture.
- The transcript contains the complete render or replacement payload.
- Approval decisions require an existing rendered `work.approvals` instance,
  an exact item ID, an explicit approve/reject choice, and the current expected
  revision. Stale and repeated decisions fail closed.
- The demo server accepts only visibly marked mock provenance. Live
  provider/account/freshness provenance requires a host-issued receipt.
- Render calls are bound to the artifact ID, version, and canonical schema
  digest returned by search; stale or invented definitions are rejected.
- The agent receives a bounded `narration.summary` and `visibleFacts` list, so
  the answer remains understandable when the native renderer is unavailable.
- Credential-free HTTPS actions to the fixture's allowlisted Google/Slack hosts
  remain navigation-only. Approval buttons stage a minimal agent request and
  require normal submission/tool permission; they never mutate directly.

## Prompt and context policy

- Suggestions are optional, expire at the end of the current turn, and carry a
  dedupe key. The agent renders at most one suggested artifact per turn.
- Suggestion ranking receives capability metadata and argument key presence,
  never argument values, provider results, tokens, or credentials.
- After rendering, the agent uses the bounded narration instead of repeating
  every visible row or pasting the structured payload.
- Approval prompts include only operation, artifact ID, instance ID, item ID,
  decision, and expected revision. They explicitly prohibit calling a real
  provider approval capability.
