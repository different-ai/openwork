import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import {
  clearCloudMcpUserState,
  isCloudMcpSyncMarkerFresh,
  readCloudMcpUserState,
  writeCloudMcpUserState,
} from "../src/react-app/domains/connections/cloud-mcp-user-state";

const DAY_MS = 24 * 60 * 60 * 1000;

// Bun runs every test file in one process: restore the global after this
// file so the window stub does not leak into other tests.
const originalWindow = (globalThis as Record<string, unknown>).window;
afterAll(() => {
  if (originalWindow === undefined) {
    delete (globalThis as Record<string, unknown>).window;
  } else {
    (globalThis as Record<string, unknown>).window = originalWindow;
  }
});

function installWindowStub() {
  const backing = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => {
      backing.set(key, value);
    },
    removeItem: (key: string) => {
      backing.delete(key);
    },
  };
  (globalThis as Record<string, unknown>).window = { localStorage };
  return backing;
}

describe("cloud MCP user state", () => {
  beforeEach(() => {
    installWindowStub();
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
    const backing = installWindowStub();
    backing.set("openwork.den.mcp.cloudControlUserState", "banana");
    expect(readCloudMcpUserState()).toBeNull();
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
    // rewrite: refresh margin == token TTL (both 7 days).
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
