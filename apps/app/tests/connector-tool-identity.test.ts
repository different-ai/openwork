import { describe, expect, test } from "bun:test";
import type { DynamicToolUIPart } from "ai";

import type { DenExternalMcpConnection } from "../src/app/lib/den";
import {
  buildConnectorToolIdentities,
  resolveConnectorToolIdentity,
} from "../src/react-app/domains/connections/connector-tool-identity";

function completedPart(toolName: string, input: Record<string, unknown>): DynamicToolUIPart {
  return {
    type: "dynamic-tool",
    toolName,
    toolCallId: `call-${toolName}`,
    state: "output-available",
    input,
    output: {},
  };
}

const granolaConnection: DenExternalMcpConnection = {
  id: "emc_granola",
  name: "Meeting notes",
  url: "https://mcp.granola.ai/mcp",
  authType: "oauth",
  credentialMode: "per_member",
  exposeDirectly: false,
  connected: true,
  connectedAt: "2026-08-26T00:00:00.000Z",
  connectedForMe: true,
  nativeProviderKey: null,
};

describe("connector tool identity", () => {
  test("recognizes native connector capabilities with a first-class local brand icon", () => {
    const identities = buildConnectorToolIdentities({ mcpServers: [], orgConnections: [] });
    const identity = resolveConnectorToolIdentity(
      completedPart("openwork-cloud_execute_capability", {
        name: "getCapabilitiesGoogleWorkspaceCalendarEvents",
      }),
      identities,
    );

    expect(identity?.name).toBe("Google Workspace");
    expect(identity?.iconUrl).toEndWith("/ext-google-workspace.svg");
  });

  test("uses the exact organization connector for opaque MCP capability names", () => {
    const identities = buildConnectorToolIdentities({
      mcpServers: [],
      orgConnections: [granolaConnection],
    });
    const identity = resolveConnectorToolIdentity(
      completedPart("openwork-cloud_execute_capability", {
        name: "mcp:emc_granola:ask_about_meetings",
      }),
      identities,
    );

    expect(identity?.name).toBe("Meeting notes");
    expect(identity?.connectionId).toBe("emc_granola");
    expect(identity?.iconUrl).toContain("granola.ai");
  });

  test("attributes projected direct tools to their connector namespace", () => {
    const identities = buildConnectorToolIdentities({ mcpServers: [], orgConnections: [] });
    const identity = resolveConnectorToolIdentity(
      completedPart("notion_search_pages", { query: "launch plan" }),
      identities,
    );

    expect(identity?.name).toBe("Notion");
    expect(identity?.iconUrl).toEndWith("/ext-notion.svg");
  });

  test("does not add connector branding to an unrelated tool", () => {
    const identities = buildConnectorToolIdentities({ mcpServers: [], orgConnections: [] });
    expect(resolveConnectorToolIdentity(completedPart("bash", { command: "pwd" }), identities)).toBeNull();
  });
});
