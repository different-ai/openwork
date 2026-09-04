import { expect } from "vitest";
import { test } from "@openwork/testkit";
import {
  dashboardCapabilityKey,
  dashboardElementKey,
} from "../../ee/apps/den-web/app/(den)/dashboard/_components/dashboard-mcp-app-catalog";

// A dashboard tile is an MCP App plus its launch input, so two tiles can share
// one app (two JQL queries on one board) while identical tiles still collapse.
const jqlSearch = {
  serverName: "openwork-app-host-connect-0123456789ab",
  toolName: "search_issues_using_jql",
};

test("dashboard tiles are identified by app and launch input, not by app alone", ({ evidence }) => {
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

  evidence.recordAssertionEvidence(
    "The same MCP App with different launch input yields two distinct dashboard tiles",
    `alpha=${alpha}; beta=${beta}`,
    sameAppDifferentInputAreTwoTiles && differentToolsAreDifferentTiles,
  );
  evidence.recordAssertionEvidence(
    "Identical tiles collapse regardless of launch-input key order or empty input",
    `reordered=${alphaReordered}; ordered=${alphaOrdered}; none=${noInput}; empty=${emptyInput}`,
    sameAppSameInputIsOneTile && absentAndEmptyInputAreOneTile,
  );
  evidence.recordAssertionEvidence(
    "The capability key counts every tile of one app regardless of its launch input",
    `capability=${dashboardCapabilityKey(jqlSearch)}`,
    capabilityIgnoresInput,
  );
});
