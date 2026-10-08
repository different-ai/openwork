import { ConnectionCard } from "@/components/chat/connection-card";
import type { ChatToolReconnectCallbacks } from "@/components/tools/use-chat-tool-reconnect";
import { createDenClient, readDenSettings } from "@/app/lib/den";
import { openDesktopUrl } from "@/app/lib/desktop";
import { isChatMcpReconnectScopeCurrent, waitForFreshMcpAuthorization } from "../session/surface/mcp-chat-reconnect";

export function DashboardConnectionCard({ toolName, toolCallId, output, onConnected }: {
  toolName: string;
  toolCallId: string;
  output: unknown;
  onConnected: () => void;
}) {
  const callbacks: ChatToolReconnectCallbacks = {
    onReconnect: async (target, onProgress) => {
      const settings = readDenSettings();
      const token = settings.authToken?.trim() ?? "";
      const organizationId = settings.activeOrgId?.trim() ?? "";
      if (!token || !organizationId) throw new Error("Sign in to OpenWork to connect your account.");
      const scope = { baseUrl: settings.baseUrl, token, organizationId };
      const isCurrent = () => {
        const current = readDenSettings();
        return isChatMcpReconnectScopeCurrent(scope, {
          baseUrl: current.baseUrl, token: current.authToken?.trim() ?? "", organizationId: current.activeOrgId?.trim() ?? "",
        }) && current.apiBaseUrl === settings.apiBaseUrl;
      };
      const assertCurrent = () => { if (!isCurrent()) throw new Error("Your OpenWork account changed. Try connecting again."); };
      const client = createDenClient({ baseUrl: settings.baseUrl, apiBaseUrl: settings.apiBaseUrl, token });
      const connections = await client.listMcpConnections(organizationId, "usable");
      assertCurrent();
      const available = connections.find((item) => item.id === target.connectionId);
      if (!available || available.authType !== "oauth" || available.credentialMode !== "per_member") {
        throw new Error(`${target.connectionName} is no longer available to connect.`);
      }
      onProgress({ phase: "opening" });
      const result = await client.startMcpConnectionConnect(organizationId, target.connectionId);
      assertCurrent();
      if (result.status !== "connected") {
        if (!result.authorizeUrl) throw new Error("Could not start sign-in.");
        await openDesktopUrl(result.authorizeUrl);
        assertCurrent();
        onProgress({ phase: "authorization_opened", authorizeUrl: result.authorizeUrl });
        await waitForFreshMcpAuthorization({ connectionId: target.connectionId, connectionName: target.connectionName,
          previousConnectedAt: available.connectedAt, listConnections: () => client.listMcpConnections(organizationId, "usable"), isScopeCurrent: isCurrent });
      }
      assertCurrent();
      onConnected();
      return "connected";
    },
    onReopenAuthorization: async (_target, url) => { await openDesktopUrl(url); },
  };
  return <ConnectionCard part={{ type: "dynamic-tool", toolName, toolCallId, state: "output-available", input: {}, output }}
    callbacks={callbacks} />;
}
