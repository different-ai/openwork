import { describe, expect, test } from "bun:test";
import { desktopFreeAccessStatusSchema, desktopFreeNotice, desktopFreeStatusFromError, unavailableDesktopFreeStatus } from "../src/app/lib/inference-access";
import {
  isAlphaChannelAllowedByDesktopConfig,
  isAlphaUpdateAllowed,
  isAlphaUpdateAllowedByVersionCeiling,
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

test("free Luna update notices require a confirmed version denial and preserve the pre-send draft promise", () => {
  const update = desktopFreeStatusFromError({ error: { code: "desktop_update_required", currentVersion: "1.0.0", minimumVersion: "1.0.1" } })!;
  expect(desktopFreeNotice(update).title).toBe("Update OpenWork to use free Luna");
  expect(desktopFreeNotice(update).body).toContain("Current version: 1.0.0. Required version: 1.0.1.");
  expect(desktopFreeNotice(update).body).toContain("Your message has not been sent. Your draft is unchanged.");
  expect(desktopFreeNotice(update, false).body).not.toContain("Your message has not been sent");
  expect(desktopFreeNotice(unavailableDesktopFreeStatus()).title).toBe("Free Luna temporarily unavailable");
  const capacity = desktopFreeStatusFromError({ error: { code: "anonymous_capacity_exceeded" } })!;
  expect(capacity.state).toBe("unavailable");
  expect(desktopFreeNotice(capacity).title).toBe("Free Luna temporarily unavailable");
  expect(desktopFreeStatusFromError("Please mention desktop_update_required")).toBeNull();
  expect(desktopFreeAccessStatusSchema.safeParse({ ...unavailableDesktopFreeStatus(), state: "ready" }).success).toBe(false);
});

test("a reservation that cannot fit is not labeled as all spent", () => {
  const notice = desktopFreeNotice({ ...unavailableDesktopFreeStatus(), state: "exhausted", code: "anonymous_reservation_does_not_fit",
    allowance: { limitUsd: 1, usedUsd: 0.2, remainingUsd: 0.8, reservedUsd: 0, resetsAt: "2026-09-14T00:00:00Z" } });
  expect(notice.title).not.toContain("used up");
  expect(notice.body).toContain("USD 1 per week per installation");
  expect(notice.body).toContain("Estimated remaining: $0.80");
  expect(notice.body).toContain("Resets");
});

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

  test("lets an installed alpha advance within its release while Den metadata lags", () => {
    expect(isAlphaUpdateAllowedByVersionCeiling({
      updateVersion: "0.18.37-alpha.2492+4921a02",
      currentVersion: "0.18.37-alpha.2491+64d2d37",
      denLatestAppVersion: "0.18.35",
      desktopConfig: { allowAlphaUpdates: true },
    })).toBe(true);
  });

  test("does not let an installed alpha bypass the ceiling for a newer release", () => {
    expect(isAlphaUpdateAllowedByVersionCeiling({
      updateVersion: "0.18.38-alpha.2493+abcdef0",
      currentVersion: "0.18.37-alpha.2491+64d2d37",
      denLatestAppVersion: "0.18.35",
      desktopConfig: { allowAlphaUpdates: true },
    })).toBe(false);
  });

  test("keeps an explicit organization ceiling in force", () => {
    expect(isAlphaUpdateAllowedByVersionCeiling({
      updateVersion: "0.18.37-alpha.2492+4921a02",
      currentVersion: "0.18.37-alpha.2491+64d2d37",
      denLatestAppVersion: "0.18.35",
      desktopConfig: {
        allowAlphaUpdates: true,
        allowedDesktopVersions: ["0.18.35"],
      },
    })).toBe(false);
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

  test("updates an installed alpha build to its published stable release", () => {
    expect(selectStableDesktopUpdate({
      currentVersion: "0.17.24-alpha.2151+5221290",
      metadata,
      desktopConfig: {},
    })).toEqual({
      kind: "update",
      targetVersion: "0.17.24",
      latestPublishedVersion: "0.17.24",
    });
  });

  test("does not downgrade an alpha build ahead of every published stable release", () => {
    expect(selectStableDesktopUpdate({
      currentVersion: "0.17.25-alpha.10+abcdef0",
      metadata,
      desktopConfig: {},
    })).toEqual({ kind: "current", latestPublishedVersion: "0.17.24" });
  });

  test("blocks an alpha build when policy has not approved the newer stable release", () => {
    expect(selectStableDesktopUpdate({
      currentVersion: "0.17.24-alpha.2151+5221290",
      metadata,
      desktopConfig: { allowedDesktopVersions: ["0.17.23"] },
    })).toEqual({ kind: "blocked", latestPublishedVersion: "0.17.24" });
  });

  test("rejects an unparseable installed version", () => {
    expect(selectStableDesktopUpdate({
      currentVersion: "not-a-version",
      metadata,
      desktopConfig: {},
    })).toBeNull();
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
