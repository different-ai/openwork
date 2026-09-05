import { describe, expect, test } from "bun:test";

import {
  grantedDashboardEntry,
  grantedEntryId,
} from "../src/react-app/domains/dashboard/granted-dashboard-store";
import type { DenDashboardElement, DenGrantedDashboard } from "../src/app/lib/den";

const element: DenDashboardElement = {
  serverName: "connect-mcp-app-host-abc",
  connectionId: "emc_123",
  toolName: "show_dashboard",
  projectedToolName: "connect_abc_show_dashboard",
  resourceUri: "ui://vendor/dashboard",
  title: "Vendor dashboard",
  launchArguments: { region: "eu", team: "ops" },
};

describe("grantedEntryId", () => {
  test("is stable for an unchanged element regardless of launch-argument key order", () => {
    const reordered: DenDashboardElement = {
      ...element,
      launchArguments: { team: "ops", region: "eu" },
    };
    expect(grantedEntryId("dsb_1", reordered)).toBe(grantedEntryId("dsb_1", element));
  });

  test("changes when any material launch field changes, discarding stored consent", () => {
    const base = grantedEntryId("dsb_1", element);
    const variants: DenDashboardElement[] = [
      { ...element, connectionId: "emc_456" },
      { ...element, resourceUri: "ui://vendor/other" },
      { ...element, projectedToolName: "connect_abc_other" },
      { ...element, launchArguments: { region: "us", team: "ops" } },
      { ...element, requiresApproval: true },
      { ...element, organizationAutoLaunch: true },
      (() => {
        const { launchArguments: _omitted, ...rest } = element;
        return rest;
      })(),
    ];
    for (const variant of variants) {
      expect(grantedEntryId("dsb_1", variant)).not.toBe(base);
    }
  });

  test("is scoped to the granting dashboard", () => {
    expect(grantedEntryId("dsb_2", element)).not.toBe(grantedEntryId("dsb_1", element));
  });

  test("applies auto-launch consent only to elements that are not approval-gated", () => {
    const dashboard: DenGrantedDashboard = {
      id: "dsb_1",
      name: "Operations",
      elements: [element],
      updatedAt: null,
    };

    expect(grantedDashboardEntry(dashboard, element, { autoLaunch: true }).autoLaunch).toBe(true);
    const approvalGatedEntry = grantedDashboardEntry(
      dashboard,
      { ...element, requiresApproval: true },
      { autoLaunch: true, launchApproved: true },
    );
    expect(approvalGatedEntry).toMatchObject({ requiresApproval: true, launchApproved: true });
    expect(approvalGatedEntry.autoLaunch).toBeUndefined();
    expect(grantedDashboardEntry(
      dashboard,
      element,
      { autoLaunch: true, launchApproved: true },
    ).autoLaunch).toBeUndefined();
    expect(grantedDashboardEntry(
      dashboard,
      { ...element, requiresApproval: true },
      { autoLaunch: true },
    ).autoLaunch).toBeUndefined();
  });

  test("applies an organization auto-launch policy independently of local approval metadata", () => {
    const dashboard: DenGrantedDashboard = {
      id: "dsb_1",
      name: "Operations",
      elements: [element],
      updatedAt: null,
    };
    const managedElement: DenDashboardElement = {
      ...element,
      requiresApproval: true,
      organizationAutoLaunch: true,
    };

    expect(grantedDashboardEntry(dashboard, managedElement, undefined)).toMatchObject({
      requiresApproval: true,
      organizationAutoLaunch: true,
    });
  });
});
