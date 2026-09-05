import { expect, test } from "bun:test";
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

test("dashboard tiles are identified by app and launch input, not by app alone", () => {
  const alpha = dashboardElementKey({ ...jqlSearch, launchArguments: { jql: "project = ALPHA" } });
  const beta = dashboardElementKey({ ...jqlSearch, launchArguments: { jql: "project = BETA" } });
  const alphaReordered = dashboardElementKey({
    ...jqlSearch,
    launchArguments: { maxResults: 20, jql: "project = ALPHA" },
  });
  const alphaOrdered = dashboardElementKey({
    ...jqlSearch,
    launchArguments: { jql: "project = ALPHA", maxResults: 20 },
  });
  const noInput = dashboardElementKey(jqlSearch);
  const emptyInput = dashboardElementKey({ ...jqlSearch, launchArguments: {} });
  const otherTool = dashboardElementKey({ ...jqlSearch, toolName: "create_issue", launchArguments: { jql: "project = ALPHA" } });

  const sameAppDifferentInputAreTwoTiles = alpha !== beta;
  const sameAppSameInputIsOneTile = alphaReordered === alphaOrdered;
  const absentAndEmptyInputAreOneTile = noInput === emptyInput;
  const differentToolsAreDifferentTiles = alpha !== otherTool;
  const capabilityIgnoresInput = dashboardCapabilityKey({ ...jqlSearch, launchArguments: { jql: "x" } })
    === dashboardCapabilityKey(jqlSearch);

  expect(sameAppDifferentInputAreTwoTiles).toBe(true);
  expect(sameAppSameInputIsOneTile).toBe(true);
  expect(absentAndEmptyInputAreOneTile).toBe(true);
  expect(differentToolsAreDifferentTiles).toBe(true);
  expect(capabilityIgnoresInput).toBe(true);
});
