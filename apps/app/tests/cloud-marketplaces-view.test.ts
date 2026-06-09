import { describe, expect, test } from "bun:test";

import { shouldShowMarketplaceRows } from "../src/react-app/domains/settings/pages/cloud-marketplaces-view";

describe("Cloud marketplace row visibility", () => {
  test("hides marketplace rows until a signed-in org is available", () => {
    expect(shouldShowMarketplaceRows(false, "org_1")).toBe(false);
    expect(shouldShowMarketplaceRows(true, "")).toBe(false);
    expect(shouldShowMarketplaceRows(true, "   ")).toBe(false);
    expect(shouldShowMarketplaceRows(true, "org_1")).toBe(true);
  });
});
