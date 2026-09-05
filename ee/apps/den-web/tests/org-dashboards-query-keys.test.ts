import { describe, expect, test } from "bun:test";

import { orgDashboardsQueryKeys } from "../app/(den)/dashboard/_components/org-dashboards-data";

describe("organization dashboard query keys", () => {
  test("scope every organization-backed dashboard cache by organization id", () => {
    expect(orgDashboardsQueryKeys.list("organization_one")).not.toEqual(
      orgDashboardsQueryKeys.list("organization_two"),
    );
    expect(orgDashboardsQueryKeys.detail("organization_one", "dashboard_one")).not.toEqual(
      orgDashboardsQueryKeys.detail("organization_two", "dashboard_one"),
    );
    expect(orgDashboardsQueryKeys.access("organization_one", "dashboard_one")).not.toEqual(
      orgDashboardsQueryKeys.access("organization_two", "dashboard_one"),
    );
    expect(orgDashboardsQueryKeys.connectionApps("organization_one", "connection_one")).not.toEqual(
      orgDashboardsQueryKeys.connectionApps("organization_two", "connection_one"),
    );
  });
});
