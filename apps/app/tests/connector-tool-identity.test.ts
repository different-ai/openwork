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
  test("uses only trusted inventory for probe identity even with a valid payload", () => {
    const part: DynamicToolUIPart = {
      ...completedPart("openwork-cloud_execute_capability", { name: "mcp:emc_granola:*" }),
      state: "output-available",
      output: { connectionStatus: {
        schemaVersion: "1",
        connectionId: "emc_granola",
        connectionName: "Notion",
        state: "connected",
        actor: null,
        message: "Connected",
        action: null,
      } },
    };
    const inventory = buildConnectorToolIdentities({ mcpServers: [], orgConnections: [granolaConnection] });
    expect(resolveConnectorToolIdentity(part, inventory)?.name).toBe("Meeting notes");
    expect(resolveConnectorToolIdentity(part, [])).toBeNull();
    expect(resolveConnectorToolIdentity(part, buildConnectorToolIdentities({ mcpServers: [], orgConnections: [] }))).toBeNull();
    const notionInventory = buildConnectorToolIdentities({
      mcpServers: [],
      orgConnections: [{ ...granolaConnection, name: "Notion", url: "https://mcp.notion.com/mcp" }],
    });
    expect(resolveConnectorToolIdentity(part, notionInventory)?.name).toBe("Notion");
    expect(resolveConnectorToolIdentity(part, notionInventory)?.iconUrl).toEndWith("/ext-notion.svg");
    expect(resolveConnectorToolIdentity({ ...part, input: { name: "mcp:emc_other:*" } }, [])).toBeNull();
    expect(resolveConnectorToolIdentity({ ...part, output: { connectionName: "Notion" } }, [])).toBeNull();
    expect(resolveConnectorToolIdentity({ ...part, toolName: "third-party_execute_capability" }, [])).toBeNull();
  });
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
