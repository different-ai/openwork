import { describe, expect, test } from "bun:test";

import { waitForProviderConnection } from "../src/react-app/domains/connections/provider-auth/store";

describe("waitForProviderConnection", () => {
  test("reloads at most once after a multi-iteration provider OAuth poll connects", async () => {
    let now = 0;
    let refreshCount = 0;
    let reloadCount = 0;

    const connected = await waitForProviderConnection({
      providerId: "anthropic",
      timeoutMs: 100,
      pollMs: 10,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      refreshProviders: async () => {
        refreshCount += 1;
        return { connected: refreshCount >= 3 ? ["anthropic"] : [] };
      },
      reloadAfterConnected: async () => {
        reloadCount += 1;
      },
    });

    expect(connected).toBe(true);
    expect(refreshCount).toBe(3);
    expect(reloadCount).toBe(1);
  });
});
