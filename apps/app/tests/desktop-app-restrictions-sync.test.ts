import { describe, expect, test } from "bun:test";

import { runDesktopAppRestrictionSyncEffects } from "../src/app/cloud/desktop-app-restrictions";

describe("runDesktopAppRestrictionSyncEffects", () => {
  test("force-disables OpenCode Zen only when org policy blocks it", async () => {
    const calls: Array<{ providerId: string; disabled: boolean }> = [];

    await runDesktopAppRestrictionSyncEffects({
      checkRestriction: ({ restriction }) => restriction === "allowZenModel",
      ensureProjectProviderDisabledState: async (providerId, disabled) => {
        calls.push({ providerId, disabled });
      },
    });

    expect(calls).toEqual([{ providerId: "opencode", disabled: true }]);
  });

  test("does not force-enable OpenCode Zen when org policy allows it", async () => {
    const calls: Array<{ providerId: string; disabled: boolean }> = [];

    await runDesktopAppRestrictionSyncEffects({
      checkRestriction: () => false,
      ensureProjectProviderDisabledState: async (providerId, disabled) => {
        calls.push({ providerId, disabled });
      },
    });

    expect(calls).toEqual([]);
  });
});
