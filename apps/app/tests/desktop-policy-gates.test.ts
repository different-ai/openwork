import { describe, expect, test } from "bun:test";

import { getDesktopPolicyDefinition } from "@openwork/types/den/desktop-policies";
import {
  getControlSettingsRouteDisabledReason,
  getDesktopConfigRestrictionDisabledReason,
  isControlSettingsTabAllowed,
} from "../src/react-app/domains/cloud/desktop-policy-gates";
import { parseSettingsPath } from "../src/react-app/shell/settings-route";

describe("declared desktop policy gates", () => {
  test("allowManageExtensions defaults to enabled when the policy is absent", () => {
    expect(getDesktopConfigRestrictionDisabledReason({
      config: {},
      restriction: "allowManageExtensions",
    })).toBeNull();
  });

  test("allowManageExtensions false disables local extension management with the policy notice", () => {
    expect(getDesktopConfigRestrictionDisabledReason({
      config: { allowManageExtensions: false },
      restriction: "allowManageExtensions",
    })).toBe(getDesktopPolicyDefinition("allowManageExtensions").userNotice);
  });

  test("allowControlSettings defaults to enabled when the policy is absent", () => {
    expect(getControlSettingsRouteDisabledReason({
      config: {},
      tab: parseSettingsPath("/settings/general").tab,
    })).toBeNull();
  });

  test("allowControlSettings false blocks settings routes with the policy notice", () => {
    expect(getControlSettingsRouteDisabledReason({
      config: { allowControlSettings: false },
      tab: parseSettingsPath("/settings/extensions").tab,
    })).toBe(getDesktopPolicyDefinition("allowControlSettings").userNotice);
  });

  test("allowControlSettings false leaves sign-out, provider auth, and recovery routes reachable", () => {
    const nonBlockableRoutes = [
      "/settings/cloud-account",
      "/settings/ai",
      "/settings/cloud-providers",
      "/settings/connect",
      "/settings/recovery",
    ];

    for (const route of nonBlockableRoutes) {
      const tab = parseSettingsPath(route).tab;
      expect(isControlSettingsTabAllowed(tab)).toBe(true);
      expect(getControlSettingsRouteDisabledReason({
        config: { allowControlSettings: false },
        tab,
      })).toBeNull();
    }
  });
});
