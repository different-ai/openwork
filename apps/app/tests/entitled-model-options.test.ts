import { describe, expect, test } from "bun:test";

import type { DesktopAppRestrictionChecker } from "../src/app/cloud/desktop-app-restrictions";
import type { ModelOption } from "../src/app/types";
import { filterEntitledModelOptions } from "../src/react-app/domains/connections/provider-auth/provider-policy";

function modelOption(providerID: string): ModelOption {
  return {
    providerID,
    modelID: "model",
    title: `${providerID} model`,
    behaviorTitle: "Reasoning",
    behaviorLabel: "Default",
    behaviorDescription: "",
    behaviorValue: null,
    isFree: false,
  };
}

function restrictionChecker(blocked: readonly string[]): DesktopAppRestrictionChecker {
  return ({ restriction }) => blocked.includes(restriction);
}

describe("filterEntitledModelOptions", () => {
  test("keeps every provider when custom providers and Zen are allowed", () => {
    const options = [modelOption("openai"), modelOption("lpr_team"), modelOption("opencode")];

    expect(
      filterEntitledModelOptions(options, {
        restrictToCloud: false,
        checkRestriction: restrictionChecker([]),
      }).map((option) => option.providerID),
    ).toEqual(["openai", "lpr_team", "opencode"]);
  });

  test("keeps only org-managed providers plus Zen when custom providers are restricted", () => {
    const options = [modelOption("openai"), modelOption("lpr_team"), modelOption("openwork"), modelOption("opencode")];

    expect(
      filterEntitledModelOptions(options, {
        restrictToCloud: true,
        checkRestriction: restrictionChecker(["allowCustomProviders"]),
      }).map((option) => option.providerID),
    ).toEqual(["lpr_team", "openwork", "opencode"]);
  });

  test("drops Zen when the Zen desktop policy blocks it", () => {
    const options = [modelOption("openai"), modelOption("lpr_team"), modelOption("opencode")];

    expect(
      filterEntitledModelOptions(options, {
        restrictToCloud: true,
        checkRestriction: restrictionChecker(["allowCustomProviders", "allowZenModel"]),
      }).map((option) => option.providerID),
    ).toEqual(["lpr_team"]);
  });

  test("with custom providers allowed, the Zen restriction only drops Zen", () => {
    const options = [modelOption("openai"), modelOption("lpr_team"), modelOption("opencode")];

    expect(
      filterEntitledModelOptions(options, {
        restrictToCloud: false,
        checkRestriction: restrictionChecker(["allowZenModel"]),
      }).map((option) => option.providerID),
    ).toEqual(["openai", "lpr_team"]);
  });
});
