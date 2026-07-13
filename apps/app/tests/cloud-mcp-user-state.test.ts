import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import {
  __setCloudMcpUserStateStorageForTest,
  clearCloudMcpUserState,
  isCloudMcpSyncMarkerFresh,
  readCloudMcpSyncMarker,
  readCloudMcpUserState,
  writeCloudMcpSyncMarker,
  writeCloudMcpUserState,
} from "../src/react-app/domains/connections/cloud-mcp-user-state";

const DAY_MS = 24 * 60 * 60 * 1000;

// Bun on Linux exposes a readonly `globalThis.window`, so the storage is
// injected via the test hook instead of stubbing the global.
function installStorageStub() {
  const backing = new Map<string, string>();
  __setCloudMcpUserStateStorageForTest({
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => {
      backing.set(key, value);
    },
    removeItem: (key: string) => {
      backing.delete(key);
    },
  });
  return backing;
}

afterAll(() => {
  __setCloudMcpUserStateStorageForTest(null);
});

describe("cloud MCP user state", () => {
  beforeEach(() => {
    installStorageStub();
  });

  test("round-trips disabled and removed intents", () => {
    expect(readCloudMcpUserState()).toBeNull();
    writeCloudMcpUserState("disabled");
    expect(readCloudMcpUserState()).toBe("disabled");
    writeCloudMcpUserState("removed");
    expect(readCloudMcpUserState()).toBe("removed");
    clearCloudMcpUserState();
    expect(readCloudMcpUserState()).toBeNull();
  });

  test("ignores corrupt stored values", () => {
    const backing = installStorageStub();
    backing.set("openwork.den.mcp.cloudControlUserState", "banana");
    expect(readCloudMcpUserState()).toBeNull();
  });

  test("rejects ambiguous legacy sync markers", () => {
    const backing = installStorageStub();
    const scope = {
      denBaseUrl: "https://cloud.openwork.test",
      serverBaseUrl: "https://worker.openwork.test",
      orgId: "organization_1",
      workspaceId: "workspace_1",
    };

    backing.set("openwork.den.mcp.sync", JSON.stringify({
      orgId: scope.orgId,
      expiresAt: "2026-07-20T00:00:00.000Z",
    }));
    expect(readCloudMcpSyncMarker(scope)).toBeNull();

    backing.set("openwork.den.mcp.sync", JSON.stringify({
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      expiresAt: "2026-07-20T00:00:00.000Z",
    }));
    expect(readCloudMcpSyncMarker(scope)).toBeNull();
  });

  test("round-trips a fully scoped versioned sync marker", () => {
    const marker = {
      denBaseUrl: "https://cloud.openwork.test",
      serverBaseUrl: "https://worker.openwork.test",
      orgId: "organization_1",
      workspaceId: "workspace_1",
      expiresAt: "2026-07-20T00:00:00.000Z",
    };
    writeCloudMcpSyncMarker(marker);
    expect(readCloudMcpSyncMarker(marker)).toEqual(marker);
  });
});

describe("isCloudMcpSyncMarkerFresh", () => {
  const now = Date.parse("2026-07-01T00:00:00.000Z");

  test("a marker written for a 7-day token is fresh with a 1-day margin", () => {
    expect(
      isCloudMcpSyncMarkerFresh({
        expiresAt: new Date(now + 7 * DAY_MS).toISOString(),
        now,
        refreshMarginMs: DAY_MS,
      }),
    ).toBe(true);
  });

  test("regression: margin equal to the token TTL makes the marker stale immediately", () => {
    // This was the bug that turned the reconciler into an every-tick config
    // rewrite: refresh margin equal to the token TTL.
    expect(
      isCloudMcpSyncMarkerFresh({
        expiresAt: new Date(now + 7 * DAY_MS).toISOString(),
        now,
        refreshMarginMs: 7 * DAY_MS,
      }),
    ).toBe(false);
  });

  test("goes stale once less than the margin remains", () => {
    expect(
      isCloudMcpSyncMarkerFresh({
        expiresAt: new Date(now + DAY_MS / 2).toISOString(),
        now,
        refreshMarginMs: DAY_MS,
      }),
    ).toBe(false);
  });

  test("treats unparseable expiry as stale", () => {
    expect(
      isCloudMcpSyncMarkerFresh({ expiresAt: "not-a-date", now, refreshMarginMs: DAY_MS }),
    ).toBe(false);
  });
});
