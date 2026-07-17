import { describe, expect, test } from "bun:test";

import {
  shouldIncludeCloudMarketplacePluginRow,
  shouldIncludeOrgMcpConnectionMarketplaceRow,
  shouldShowMarketplaceRows,
} from "../src/react-app/domains/settings/pages/cloud-marketplaces-view";

describe("Cloud marketplace row visibility", () => {
  test("hides marketplace rows until a signed-in org is available", () => {
    expect(shouldShowMarketplaceRows(false, "org_1")).toBe(false);
    expect(shouldShowMarketplaceRows(true, "")).toBe(false);
    expect(shouldShowMarketplaceRows(true, "   ")).toBe(false);
    expect(shouldShowMarketplaceRows(true, "org_1")).toBe(true);
  });

  test("keeps Den organization plugins out of the embedded Extensions Marketplace pane", () => {
    expect(shouldIncludeCloudMarketplacePluginRow({ embedded: false })).toBe(true);
    expect(shouldIncludeCloudMarketplacePluginRow({ embedded: true })).toBe(false);
  });

  test("keeps organization MCP connections out of both Marketplace surfaces", () => {
    expect(shouldIncludeOrgMcpConnectionMarketplaceRow({ embedded: false })).toBe(false);
    expect(shouldIncludeOrgMcpConnectionMarketplaceRow({ embedded: true })).toBe(false);
  });
});
