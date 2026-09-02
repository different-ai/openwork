import { describe, expect, test } from "bun:test";

import {
  applyRestrictedDesktopPolicy,
  calculateEffectiveDesktopPolicy,
  desktopPolicyDefaults,
  desktopPolicyDefinitions,
  isRestrictedDesktopPolicyValue,
  restrictedDesktopPolicyValue,
} from "@openwork/types/den/desktop-policies";
import {
  SETTINGS_TAB_WITHOUT_CONTROL,
  checkDesktopAppRestriction,
  desktopRestrictionNotice,
  isSettingsTabAllowed,
  type DesktopAppRestrictionChecker,
} from "../src/app/cloud/desktop-app-restrictions";
import { SETTINGS_TAB_VALUES } from "../src/app/types";

const allowEverything: DesktopAppRestrictionChecker = () => false;
const restrictedChecker: DesktopAppRestrictionChecker = ({ restriction }) =>
  checkDesktopAppRestriction({ config: restrictedDesktopPolicyValue, restriction });

describe("restricted desktop policy mode", () => {
  test("locks every capability and leaves the welcome page preference alone", () => {
    expect(restrictedDesktopPolicyValue).toEqual({
      allowCustomProviders: false,
      allowZenModel: false,
      allowMultipleWorkspaces: false,
      allowControlSettings: false,
      allowManageExtensions: false,
      allowBuiltInExtensions: false,
      allowAlphaUpdates: false,
      showWelcomePage: true,
    });
    expect(
      applyRestrictedDesktopPolicy({ ...desktopPolicyDefaults, showWelcomePage: false }).showWelcomePage,
    ).toBe(false);
  });

  test("every catalog key declares how Restricted treats it", () => {
    for (const definition of desktopPolicyDefinitions) {
      expect([true, false, null]).toContain(definition.restrictedValue);
    }
  });

  test("derives the mode from saved values", () => {
    expect(isRestrictedDesktopPolicyValue(restrictedDesktopPolicyValue)).toBe(true);
    expect(isRestrictedDesktopPolicyValue({ ...restrictedDesktopPolicyValue, showWelcomePage: false })).toBe(true);
    expect(isRestrictedDesktopPolicyValue(desktopPolicyDefaults)).toBe(false);
    expect(isRestrictedDesktopPolicyValue({ ...restrictedDesktopPolicyValue, allowManageExtensions: true })).toBe(false);
  });

  test("a restricted default policy locks members down until an assigned policy grants more", () => {
    const locked = calculateEffectiveDesktopPolicy({
      orgPolicyCount: 1,
      defaultPolicy: restrictedDesktopPolicyValue,
      assignedPolicies: [],
    });
    expect(locked.allowControlSettings).toBe(false);
    expect(locked.allowManageExtensions).toBe(false);
    expect(locked.allowCustomProviders).toBe(false);
    expect(locked.showWelcomePage).toBe(true);

    const unlockedForTeam = calculateEffectiveDesktopPolicy({
      orgPolicyCount: 2,
      defaultPolicy: restrictedDesktopPolicyValue,
      assignedPolicies: [{ allowManageExtensions: true }],
    });
    expect(unlockedForTeam.allowManageExtensions).toBe(true);
    expect(unlockedForTeam.allowControlSettings).toBe(false);
  });
});

describe("allowControlSettings settings gate", () => {
  test("leaves every settings tab reachable without a policy", () => {
    for (const tab of SETTINGS_TAB_VALUES) {
      expect(isSettingsTabAllowed({ tab, checkRestriction: allowEverything })).toBe(true);
    }
  });

  test("keeps only the Cloud tabs when the organization blocks settings control", () => {
    const allowed = SETTINGS_TAB_VALUES.filter((tab) =>
      isSettingsTabAllowed({ tab, checkRestriction: restrictedChecker }),
    );
    expect(allowed).toEqual(["cloud-account"]);
    expect(allowed).toContain(SETTINGS_TAB_WITHOUT_CONTROL);
    expect(isSettingsTabAllowed({ tab: "general", checkRestriction: restrictedChecker })).toBe(false);
    expect(isSettingsTabAllowed({ tab: "extensions", checkRestriction: restrictedChecker })).toBe(false);
    expect(isSettingsTabAllowed({ tab: "ai", checkRestriction: restrictedChecker })).toBe(false);
  });

  test("explains blocked capabilities with the catalog notice", () => {
    expect(desktopRestrictionNotice("allowManageExtensions")).toBe(
      "Your organization administrator has disabled local extension management.",
    );
    expect(desktopRestrictionNotice("allowControlSettings")).toBe(
      "Your organization administrator has disabled changing desktop app settings.",
    );
  });
});
