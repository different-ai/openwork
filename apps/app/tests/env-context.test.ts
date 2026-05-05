import { describe, expect, test } from "bun:test";

import type { OpenworkServerClient } from "../src/app/lib/openwork-server";
import {
  buildOpenworkEnvSystemContext,
  clearOpenworkEnvSystemContextCache,
} from "../src/react-app/domains/session/sync/env-context";

function client(keys: string[], calls: { count: number }): OpenworkServerClient {
  return {
    baseUrl: "http://127.0.0.1:3000",
    listUserEnvKeys: async () => {
      calls.count += 1;
      return { keys };
    },
  } as OpenworkServerClient;
}

describe("buildOpenworkEnvSystemContext", () => {
  test("lists configured key names without inventing secret values", async () => {
    clearOpenworkEnvSystemContextCache();
    const calls = { count: 0 };
    const context = await buildOpenworkEnvSystemContext(
      client(["NBA_LIVE_KEY", "bad-key", "ANTHROPIC_API_KEY", "NBA_LIVE_KEY"], calls),
      {
        cacheKey: "session-a",
        readPendingChanges: () => false,
      },
    );

    expect(context).toContain("- ANTHROPIC_API_KEY");
    expect(context).toContain("- NBA_LIVE_KEY");
    expect(context).not.toContain("bad-key");
    expect(context).not.toContain("sk-ant-secret");
    expect(calls.count).toBe(1);
  });

  test("caches key context per session", async () => {
    clearOpenworkEnvSystemContextCache();
    const calls = { count: 0 };
    const server = client(["OPENROUTER_API_KEY"], calls);

    await buildOpenworkEnvSystemContext(server, {
      cacheKey: "session-a",
      readPendingChanges: () => false,
    });
    await buildOpenworkEnvSystemContext(server, {
      cacheKey: "session-a",
      readPendingChanges: () => false,
    });
    await buildOpenworkEnvSystemContext(server, {
      cacheKey: "session-b",
      readPendingChanges: () => false,
    });

    expect(calls.count).toBe(2);
  });

  test("does not truncate long key lists", async () => {
    clearOpenworkEnvSystemContextCache();
    const calls = { count: 0 };
    const keys = Array.from({ length: 90 }, (_, index) => `KEY_${index}`);
    const context = await buildOpenworkEnvSystemContext(client(keys, calls), {
      cacheKey: "session-a",
      readPendingChanges: () => false,
    });

    expect(context).toContain("- KEY_0");
    expect(context).toContain("- KEY_89");
    expect(context).not.toContain("and 10 more");
  });

  test("skips context while environment changes are pending", async () => {
    clearOpenworkEnvSystemContextCache();
    const calls = { count: 0 };
    const context = await buildOpenworkEnvSystemContext(client(["ANTHROPIC_API_KEY"], calls), {
      cacheKey: "session-a",
      readPendingChanges: () => true,
    });

    expect(context).toBeUndefined();
    expect(calls.count).toBe(0);
  });
});
