import { describe, expect, test } from "bun:test";
import {
  dashboardCapabilityKey,
  dashboardElementKey,
} from "../app/(den)/dashboard/_components/dashboard-mcp-app-catalog";

// A dashboard tile is an MCP App plus its launch input, so two tiles can share
// one app (two JQL queries on one board) while identical tiles still collapse.
const jqlSearch = {
  serverName: "openwork-app-host-connect-0123456789ab",
  toolName: "search_issues_using_jql",
};

describe("dashboard tile identity", () => {
  test("the same app with different launch input is two tiles", () => {
    const alpha = dashboardElementKey({ ...jqlSearch, launchArguments: { jql: "project = ALPHA" } });
    const beta = dashboardElementKey({ ...jqlSearch, launchArguments: { jql: "project = BETA" } });
    const otherTool = dashboardElementKey({ ...jqlSearch, toolName: "create_issue", launchArguments: { jql: "project = ALPHA" } });
    expect(alpha).not.toBe(beta);
    expect(alpha).not.toBe(otherTool);
  });

  test("identical tiles collapse regardless of key order or empty input", () => {
    const reordered = dashboardElementKey({ ...jqlSearch, launchArguments: { maxResults: 20, jql: "project = ALPHA" } });
    const ordered = dashboardElementKey({ ...jqlSearch, launchArguments: { jql: "project = ALPHA", maxResults: 20 } });
    expect(reordered).toBe(ordered);
    expect(dashboardElementKey(jqlSearch)).toBe(dashboardElementKey({ ...jqlSearch, launchArguments: {} }));
  });

  test("the capability key counts every tile of one app regardless of launch input", () => {
    expect(dashboardCapabilityKey({ ...jqlSearch, launchArguments: { jql: "x" } })).toBe(dashboardCapabilityKey(jqlSearch));
  });
});
