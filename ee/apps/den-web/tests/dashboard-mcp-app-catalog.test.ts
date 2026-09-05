import { describe, expect, test } from "bun:test";
import {
  filterConnectionsWithMcpApps,
  flattenConnectionMcpAppCatalog,
  type ConnectionMcpApp,
} from "../app/(den)/dashboard/_components/org-dashboards-data";
import {
  connectionCanListMcpApps,
  mcpAppCatalogIsLoading,
} from "../app/(den)/dashboard/_components/dashboard-mcp-app-catalog";
import { missingRequiredInputKeys } from "../app/(den)/dashboard/_components/org-dashboard-detail-screen";

const app: ConnectionMcpApp = {
  serverName: "reports",
  connectionId: "connection_reports",
  toolName: "render_report",
  projectedToolName: "reports_render_report",
  resourceUri: "ui://reports/view.html",
  title: "Weekly report",
  description: "Shows the weekly report",
  requiresInput: false,
  requiredInputKeys: [],
  requiresApproval: false,
};

describe("dashboard MCP App catalog", () => {
  test("flattens apps and omits connections that do not expose MCP Apps", () => {
    expect(flattenConnectionMcpAppCatalog(
      [
        { id: "connection_tools", name: "Tools only" },
        { id: "connection_reports", name: "Reports" },
      ],
      [[], [app]],
    )).toEqual([{ ...app, connectionName: "Reports" }]);

    expect(filterConnectionsWithMcpApps(
      [
        { id: "connection_tools", name: "Tools only" },
        { id: "connection_reports", name: "Reports" },
      ],
      [app],
    )).toEqual([{ id: "connection_reports", name: "Reports" }]);
  });

  test("discovers Apps only for connections ready for the current admin", () => {
    expect(connectionCanListMcpApps({ connectedForMe: true })).toBe(true);
    expect(connectionCanListMcpApps({ connectedForMe: false })).toBe(false);
    expect(connectionCanListMcpApps({ connectedForMe: true, needsReconnect: true })).toBe(false);
    expect(connectionCanListMcpApps({ connectedForMe: true, credentialHealth: "reconnect_required" })).toBe(false);
    expect(connectionCanListMcpApps({ connectedForMe: true, setupRequired: true })).toBe(false);
  });

  test("shows discovered Apps while another MCP is still loading", () => {
    expect(mcpAppCatalogIsLoading(0, true)).toBe(true);
    expect(mcpAppCatalogIsLoading(1, true)).toBe(false);
  });

  test("names the required launch-input keys a pasted payload omits", () => {
    // A launch input missing a key the tool requires fails on every launch,
    // so the add-app dialog must refuse it and say which key is missing.
    expect(missingRequiredInputKeys(["cloudId", "pageId"], { pageId: "1122334455" })).toEqual(["cloudId"]);
    expect(missingRequiredInputKeys(["cloudId", "jql"], { jql: "project = HELPDESK" })).toEqual(["cloudId"]);
    expect(missingRequiredInputKeys(["cloudId", "jql"], { cloudId: "example-cloud-id", jql: "project = HELPDESK" })).toEqual([]);
    expect(missingRequiredInputKeys(["cloudId"], { cloudId: undefined })).toEqual(["cloudId"]);
    expect(missingRequiredInputKeys([], {})).toEqual([]);
  });
});
