import { describe, expect, test } from "bun:test";
import {
  isAlphaChannelAllowedByDesktopConfig,
  isAlphaUpdateAllowed,
  resolveAutomaticStableDesktopUpdate,
  resolveDesktopUpdateChannel,
  resolveFreshStableDesktopUpdate,
  selectStableDesktopUpdate,
} from "../src/app/lib/version-gate";

const metadata = {
  minAppVersion: "0.11.207",
  latestAppVersion: "0.17.24",
  publishedDesktopVersions: ["0.17.22", "0.17.23", "0.17.24"],
};

describe("alpha desktop update policy", () => {
  test("keeps alpha available when the policy is missing or enabled", () => {
    expect(isAlphaChannelAllowedByDesktopConfig({})).toBe(true);
    expect(isAlphaChannelAllowedByDesktopConfig({ allowAlphaUpdates: true })).toBe(true);
    expect(resolveDesktopUpdateChannel("alpha", {})).toBe("alpha");
  });

  test("forces policy-disabled alpha selections back to stable", () => {
    const desktopConfig = { allowAlphaUpdates: false };

    expect(isAlphaChannelAllowedByDesktopConfig(desktopConfig)).toBe(false);
    expect(resolveDesktopUpdateChannel("alpha", desktopConfig)).toBe("stable");
    expect(resolveDesktopUpdateChannel("stable", desktopConfig)).toBe("stable");
  });

  test("blocks policy-disabled alpha builds before consulting Den", async () => {
    await expect(
      isAlphaUpdateAllowed("999.0.0-alpha.1", { allowAlphaUpdates: false }),
    ).resolves.toBe(false);
  });
});

describe("selectStableDesktopUpdate", () => {
  test("selects the highest approved published release above the installed version", () => {
    expect(selectStableDesktopUpdate({
      currentVersion: "0.17.22",
      metadata,
      desktopConfig: { allowedDesktopVersions: ["0.17.23"] },
    })).toEqual({
      kind: "update",
      targetVersion: "0.17.23",
      latestPublishedVersion: "0.17.24",
    });
  });

  test("reports a newer published release that still needs administrator approval", () => {
    expect(selectStableDesktopUpdate({
      currentVersion: "0.17.23",
      metadata,
      desktopConfig: { allowedDesktopVersions: ["0.17.23"] },
    })).toEqual({ kind: "blocked", latestPublishedVersion: "0.17.24" });
  });

  test("never selects an older approved release", () => {
    expect(selectStableDesktopUpdate({
      currentVersion: "0.17.23",
      metadata,
      desktopConfig: { allowedDesktopVersions: ["0.17.22"] },
    })).toEqual({ kind: "blocked", latestPublishedVersion: "0.17.24" });
  });

  test("keeps unrestricted organizations on the latest compatible published release", () => {
    expect(selectStableDesktopUpdate({
      currentVersion: "0.17.22",
      metadata,
      desktopConfig: {},
    })).toEqual({
      kind: "update",
      targetVersion: "0.17.24",
      latestPublishedVersion: "0.17.24",
    });
  });

  test("does not downgrade when the installed version is newer than Den's inventory", () => {
    expect(selectStableDesktopUpdate({
      currentVersion: "0.17.25",
      metadata,
      desktopConfig: {},
    })).toEqual({ kind: "current", latestPublishedVersion: "0.17.24" });
  });

  test("uses the config returned by the manual refresh instead of a stale cached policy", async () => {
    let refreshCalls = 0;
    const selection = await resolveFreshStableDesktopUpdate({
      currentVersion: "0.17.22",
      refreshDesktopConfig: async () => {
        refreshCalls += 1;
        return { allowedDesktopVersions: ["0.17.23"] };
      },
      readMetadata: async () => metadata,
    });

    expect(refreshCalls).toBe(1);
    expect(selection).toEqual({
      kind: "update",
      targetVersion: "0.17.23",
      latestPublishedVersion: "0.17.24",
    });
  });
});

describe("resolveAutomaticStableDesktopUpdate", () => {
  test("selects an exact approved published fallback when automatic latest is blocked", async () => {
    const targetVersion = await resolveAutomaticStableDesktopUpdate({
      currentVersion: "0.12.13",
      latestVersion: "0.12.18",
      desktopConfig: { allowedDesktopVersions: ["0.12.16"] },
      readMetadata: async () => ({
        minAppVersion: "0.12.13",
        latestAppVersion: "0.12.18",
        publishedDesktopVersions: ["0.12.13", "0.12.16", "0.12.18"],
      }),
    });

    expect(targetVersion).toBe("0.12.16");
  });

  test("does not target configured versions missing from the published inventory", async () => {
    const targetVersion = await resolveAutomaticStableDesktopUpdate({
      currentVersion: "0.12.13",
      latestVersion: "0.12.18",
      desktopConfig: { allowedDesktopVersions: ["0.12.16"] },
      readMetadata: async () => ({
        minAppVersion: "0.12.13",
        latestAppVersion: "0.12.18",
        publishedDesktopVersions: ["0.12.13", "0.12.18"],
      }),
    });

    expect(targetVersion).toBeNull();
  });

  test("does not target a downgrade", async () => {
    const targetVersion = await resolveAutomaticStableDesktopUpdate({
      currentVersion: "0.12.16",
      latestVersion: "0.12.18",
      desktopConfig: { allowedDesktopVersions: ["0.12.13"] },
      readMetadata: async () => ({
        minAppVersion: "0.12.13",
        latestAppVersion: "0.12.18",
        publishedDesktopVersions: ["0.12.13", "0.12.16", "0.12.18"],
      }),
    });

    expect(targetVersion).toBeNull();
  });

  test("leaves unrestricted organizations on the normal latest check", async () => {
    let metadataReads = 0;
    const targetVersion = await resolveAutomaticStableDesktopUpdate({
      currentVersion: "0.12.13",
      latestVersion: "0.12.18",
      desktopConfig: {},
      readMetadata: async () => {
        metadataReads += 1;
        return metadata;
      },
    });

    expect(targetVersion).toBeNull();
    expect(metadataReads).toBe(0);
  });

  test("leaves an approved latest release on the normal latest check", async () => {
    let metadataReads = 0;
    const targetVersion = await resolveAutomaticStableDesktopUpdate({
      currentVersion: "0.12.13",
      latestVersion: "0.12.18",
      desktopConfig: { allowedDesktopVersions: ["0.12.18"] },
      readMetadata: async () => {
        metadataReads += 1;
        return metadata;
      },
    });

    expect(targetVersion).toBeNull();
    expect(metadataReads).toBe(0);
  });
});
