import { describe, expect, test } from "bun:test";

import { checkDesktopAppRestriction, isDesktopProviderBlocked } from "../src/app/cloud/desktop-app-restrictions";

// Zen is retired through the restriction every surface reads, even signed out,
// offline, or connected to an older server with a stale rollout value.
describe("OpenCode Zen retirement", () => {
  const blocked = (input: Parameters<typeof checkDesktopAppRestriction>[0]) =>
    isDesktopProviderBlocked({ providerId: "opencode", checkRestriction: ({ restriction }) => checkDesktopAppRestriction({ ...input, restriction }) });

  test("Zen is unavailable without organization policy or a network request", () => {
    for (const config of [null, undefined, {}]) {
      expect(checkDesktopAppRestriction({ config, restriction: "allowZenModel" })).toBe(true);
      expect(blocked({ config, restriction: "allowZenModel" })).toBe(true);
    }
  });

  test("stale server flags and organization policy cannot restore Zen", () => {
    for (const config of [{ removeOpencodeZen: false }, { removeOpencodeZen: true }, { allowZenModel: true }]) {
      expect(blocked({ config, restriction: "allowZenModel" })).toBe(true);
    }
  });

  test("only Zen is affected", () => {
    const config = {};
    expect(checkDesktopAppRestriction({ config, restriction: "allowCustomProviders" })).toBe(false);
    expect(isDesktopProviderBlocked({ providerId: "openai", checkRestriction: ({ restriction }) => checkDesktopAppRestriction({ config, restriction }) })).toBe(false);
  });
});
