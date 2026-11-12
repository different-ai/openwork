# Fix a changed artifact tool with an agent (`appToolRepair`)

- **Feature key:** `appToolRepair`
- **Deployments:** cloud and self-hosted (`everywhere`), off by default
- **Author:** @reachjalil

## What people get

An artifact binds each connected tool it uses to that tool's inputs at the time
the artifact was published. When the provider later changes the tool (its inputs,
or a label the artifact relied on, such as read-only), OpenWork blocks the artifact's
calls to it, and before this feature the artifact only showed that error.

With the feature on, when one of these calls is refused in **Artifacts**, a
row appears above the artifact for members who manage it:

> “load_issues” changed since this artifact was published. Update the artifact to use the
> tool again. **Fix with agent**

**Fix with agent** starts a new conversation that asks the agent to read the
artifact with `read_app`, find what the tool takes now, and save the fix with
`update_app` under the same artifact ID, without making a copy. If the
conversation cannot start, the row says so and the button can be tried
again. Members who do not manage the artifact see only the artifact's own error, as
before.

Den marks these refusals with `reason: "app_needs_update"` and the artifact's own
tool name. The row appears only when that tool is the one the artifact just
called. That marking is on for everyone and changes nothing people see
without this feature.

## Off

Turning it off removes the row and the button. Nothing is stored, and a
conversation already started is unaffected, so it is safe to turn off at any
moment.

## Try it

1. Turn `appToolRepair` on for your organization in `/admin`.
2. Publish an artifact that calls a tool on a connection you can change, such as
   a custom MCP server, then change that tool's input schema at the server.
3. Open the artifact in Artifacts as one of its managers. When the artifact calls the
   tool, the row appears; **Fix with agent** opens the conversation.

Usage is recorded when someone presses **Fix with agent**.

## Code

- Den: `ee/apps/den-api/src/mcp/app-tool-access.ts` (`appToolChangeMessage`)
  and `callMcpAppTool` in `ee/apps/den-api/src/mcp/app-tools.ts`.
- Desktop: `apps/app/src/components/chat/mcp-app-tool-change.tsx`, shown by
  `McpAppSandboxView` when its host passes `onFixChangedTool`, which the
  Artifacts page does only with the feature on and for an artifact the member
  manages.
