import { OpenworkServerError, type OpenworkMcpAppResource, type OpenworkServerClient } from "@/app/lib/openwork-server";
import { createMcpAppConversation } from "./mcp-app-conversation";

/** The host surface owns this value. Never derive it from the selected workspace or App HTML. */
export type McpAppOrigin = {
  client: OpenworkServerClient;
  workspaceId: string;
  sessionId: string | null;
  engine?: "v1" | "v2";
  readOnly: boolean;
};

/** One bridge lifetime, including any approval that is still waiting when it closes. */
export function createMcpAppActions(origin: McpAppOrigin, app: OpenworkMcpAppResource, confirm: (message: string) => boolean | Promise<boolean>) {
  let active = true;
  const assertActive = () => {
    if (!active) throw new Error("This App view has closed or changed. Reopen it before using its actions.");
    if (origin.readOnly) throw new Error("This view is read-only and cannot perform App actions.");
    if (!app.launchId) throw new Error("This App has no live launch context. Update OpenWork and reopen the App.");
  };
  const conversation = createMcpAppConversation(origin, app, assertActive);
  return {
    ...conversation,
    dispose: () => { active = false; conversation.dispose(); },
    assertActive,
    callTool: async (name: string, args?: Record<string, unknown>) => {
      assertActive();
      const request = {
        launchId: app.launchId,
        sessionId: origin.sessionId,
        ...(origin.engine ? { engine: origin.engine } : {}),
        serverName: app.serverName,
        resourceUri: app.resourceUri,
        name,
        arguments: args,
      };
      try {
        const result = await origin.client.callMcpAppTool(origin.workspaceId, request);
        assertActive();
        return result;
      } catch (cause) {
        assertActive();
        if (!(cause instanceof OpenworkServerError) || cause.code !== "tool_requires_approval") throw cause;
        const approved = await confirm(`Allow this MCP App to call ${name} on ${app.serverName}?`);
        assertActive();
        if (!approved) throw new Error("The user declined the MCP App tool call.");
        const result = await origin.client.callMcpAppTool(origin.workspaceId, { ...request, approved: true });
        assertActive();
        return result;
      }
    },
  };
}
