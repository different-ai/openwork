import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import {
  __setCloudMcpUserStateStorageForTest,
  clearCloudMcpUserState,
  clearCloudMcpUnhealthyRemintAttempt,
  isCloudMcpSyncMarkerFresh,
  readCloudMcpSyncMarker,
  readCloudMcpUnhealthyRemintAttempt,
  readCloudMcpUserState,
  writeCloudMcpSyncMarker,
  writeCloudMcpUnhealthyRemintAttempt,
  writeCloudMcpUserState,
} from "../src/react-app/domains/connections/cloud-mcp-user-state";

const DAY_MS = 24 * 60 * 60 * 1000;
const scope = {
  denBaseUrl: "https://cloud.openwork.test",
  serverBaseUrl: "https://worker.openwork.test",
  orgId: "organization_1",
  workspaceId: "workspace_1",
};
const otherScope = {
  ...scope,
  workspaceId: "workspace_2",
};

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

  test("round-trips disabled and removed intents per scope", () => {
    expect(readCloudMcpUserState(scope)).toBeNull();
    writeCloudMcpUserState("disabled", scope);
    expect(readCloudMcpUserState(scope)).toBe("disabled");
    expect(readCloudMcpUserState(otherScope)).toBeNull();
    writeCloudMcpUserState("removed", scope);
    expect(readCloudMcpUserState(scope)).toBe("removed");
    clearCloudMcpUserState(scope);
    expect(readCloudMcpUserState(scope)).toBeNull();
  });

  test("ignores corrupt stored values", () => {
    const backing = installStorageStub();
    backing.set("openwork.den.mcp.cloudControlUserState", "banana");
    expect(readCloudMcpUserState(scope)).toBeNull();
  });

  test("migrates legacy global intent to only the active scope", () => {
    const backing = installStorageStub();
    backing.set("openwork.den.mcp.cloudControlUserState", "disabled");
    expect(readCloudMcpUserState(scope)).toBe("disabled");
    expect(readCloudMcpUserState(otherScope)).toBeNull();
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

  test("scopes unhealthy remint attempts", () => {
    writeCloudMcpUnhealthyRemintAttempt({ ...scope, attemptedAt: 123 });
    expect(readCloudMcpUnhealthyRemintAttempt(scope)?.attemptedAt).toBe(123);
    expect(readCloudMcpUnhealthyRemintAttempt(otherScope)).toBeNull();
    clearCloudMcpUnhealthyRemintAttempt(scope);
    expect(readCloudMcpUnhealthyRemintAttempt(scope)).toBeNull();
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
