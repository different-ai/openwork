# Fix a changed App tool with an agent (`appToolRepair`)

- **Feature key:** `appToolRepair`
- **Deployments:** cloud and self-hosted (`everywhere`), off by default
- **Author:** @reachjalil

## What people get

An App binds each connected tool it uses to that tool's inputs at the time
the App was published. When the provider later changes the tool (its inputs,
or a label the App relied on, such as read-only), OpenWork blocks the App's
calls to it, and before this feature the App only showed that error.

With the feature on, when one of these calls is refused in **Artifacts**, a
row appears above the App for members who manage it:

> “load_issues” changed since this App was published, so the App can’t use
> it until it’s updated. **Fix with agent**

**Fix with agent** starts a new conversation that asks the agent to read the
App with `read_app`, find what the tool takes now, and save the fix with
`update_app` under the same App ID, without making a copy. If the
conversation cannot start, the row says so and the button can be tried
again. Members who do not manage the App see only the App's own error, as
before.

Den marks these refusals with `reason: "app_needs_update"` and the App's own
tool name. The row appears only when that tool is the one the App just
called. That marking is on for everyone and changes nothing people see
without this feature.

## Off

Turning it off removes the row and the button. Nothing is stored, and a
conversation already started is unaffected, so it is safe to turn off at any
moment.

## Try it

1. Turn `appToolRepair` on for your organization in `/admin`.
2. Publish an App that calls a tool on a connection you can change, such as
   a custom MCP server, then change that tool's input schema at the server.
3. Open the App in Artifacts as one of its managers. When the App calls the
   tool, the row appears; **Fix with agent** opens the conversation.

Usage is recorded when someone presses **Fix with agent**.

## Code

- Den: `ee/apps/den-api/src/mcp/app-tool-access.ts` (`appToolChangeMessage`)
  and `callMcpAppTool` in `ee/apps/den-api/src/mcp/app-tools.ts`.
- Desktop: `apps/app/src/components/chat/mcp-app-tool-change.tsx`, shown by
  `McpAppSandboxView` when its host passes `onFixChangedTool`, which the
  Artifacts page does only with the feature on and for an App the member
  manages.
