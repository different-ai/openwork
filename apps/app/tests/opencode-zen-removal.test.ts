import { describe, expect, test } from "bun:test";

import { desktopPolicyDefinitions } from "@openwork/types/den/desktop-policies";

import { checkDesktopAppRestriction, isDesktopProviderBlocked, showsRetiredOpencodeZen } from "../src/app/cloud/desktop-app-restrictions";

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

  test("Connect a provider shows Zen as retired where it used to be", () => {
    expect(showsRetiredOpencodeZen({ providerIds: ["openai", "anthropic"], query: "" })).toBe(true);
    for (const query of ["zen", "OpenCode", "big pickle", " free "]) {
      expect(showsRetiredOpencodeZen({ providerIds: ["openai"], query })).toBe(true);
    }
    expect(showsRetiredOpencodeZen({ providerIds: ["openai"], query: "openai" })).toBe(false);
    expect(showsRetiredOpencodeZen({ providerIds: ["opencode"], query: "" })).toBe(false);
  });

  test("the organization switch stored as allowZenModel is labelled as the free starter model", () => {
    const entry = desktopPolicyDefinitions.find((definition) => definition.id === "allowZenModel");
    expect(entry?.name).toBe("Free starter model (Auto)");
    for (const copy of [entry?.name, entry?.userNotice]) expect(copy).not.toMatch(/zen|opencode/i);
  });
});
