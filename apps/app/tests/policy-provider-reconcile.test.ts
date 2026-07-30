import { describe, expect, test } from "bun:test";

import type { DesktopAppRestrictionChecker } from "../src/app/cloud/desktop-app-restrictions";
import {
  computePolicyProviderReconcilePlan,
  type PolicyProviderListItem,
} from "../src/react-app/domains/connections/policy-provider-reconcile";

function provider(id: string): PolicyProviderListItem {
  return { id };
}

function restrictionChecker(blocked: readonly string[]): DesktopAppRestrictionChecker {
  return ({ restriction }) => blocked.includes(restriction);
}

describe("computePolicyProviderReconcilePlan", () => {
  test("disables a connected custom provider when custom providers are restricted", () => {
    expect(
      computePolicyProviderReconcilePlan({
        allProviders: [provider("openai")],
        connectedProviderIds: ["openai"],
        disabledProviderIds: [],
        markedDisabledProviderIds: [],
        checkRestriction: restrictionChecker(["allowCustomProviders"]),
      }),
    ).toEqual({
      toDisable: ["openai"],
      toReenable: [],
      nextMarkedDisabledProviderIds: ["openai"],
    });
  });

  test("re-enables only providers previously disabled by policy", () => {
    expect(
      computePolicyProviderReconcilePlan({
        allProviders: [provider("openai"), provider("anthropic")],
        connectedProviderIds: [],
        disabledProviderIds: ["openai", "anthropic"],
        markedDisabledProviderIds: ["openai"],
        checkRestriction: restrictionChecker([]),
      }),
    ).toEqual({
      toDisable: [],
      toReenable: ["openai"],
      nextMarkedDisabledProviderIds: [],
    });
  });

  test("leaves user-disabled providers untouched", () => {
    expect(
      computePolicyProviderReconcilePlan({
        allProviders: [provider("openai")],
        connectedProviderIds: [],
        disabledProviderIds: ["openai"],
        markedDisabledProviderIds: [],
        checkRestriction: restrictionChecker([]),
      }),
    ).toEqual({
      toDisable: [],
      toReenable: [],
      nextMarkedDisabledProviderIds: [],
    });
  });

  test("never disables cloud-managed providers under the custom-provider restriction", () => {
    expect(
      computePolicyProviderReconcilePlan({
        allProviders: [provider("lpr_team"), provider("openwork"), provider("openai")],
        connectedProviderIds: ["lpr_team", "openwork", "openai"],
        disabledProviderIds: [],
        markedDisabledProviderIds: [],
        checkRestriction: restrictionChecker(["allowCustomProviders"]),
      }).toDisable,
    ).toEqual(["openai"]);
  });

  test("respects the Zen policy while custom providers are restricted", () => {
    expect(
      computePolicyProviderReconcilePlan({
        allProviders: [provider("opencode")],
        connectedProviderIds: ["opencode"],
        disabledProviderIds: [],
        markedDisabledProviderIds: [],
        checkRestriction: restrictionChecker(["allowCustomProviders"]),
      }).toDisable,
    ).toEqual([]);

    expect(
      computePolicyProviderReconcilePlan({
        allProviders: [provider("opencode")],
        connectedProviderIds: ["opencode"],
        disabledProviderIds: [],
        markedDisabledProviderIds: [],
        checkRestriction: restrictionChecker(["allowCustomProviders", "allowZenModel"]),
      }).toDisable,
    ).toEqual(["opencode"]);
  });
});
