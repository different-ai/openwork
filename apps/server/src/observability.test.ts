import { describe, expect, test } from "bun:test";
import {
  DEFAULT_OBSERVABILITY_LEASE_MS,
  createServerObservabilityController,
  normalizeObservabilityEventInput,
} from "./observability.js";

describe("server observability controller", () => {
  test("uses a 30-minute crash-failsafe lease by default", () => {
    expect(DEFAULT_OBSERVABILITY_LEASE_MS).toBe(30 * 60 * 1_000);
  });

  test("is disabled by default, records enable/config transitions, and clears on disable", () => {
    const controller = createServerObservabilityController();
    expect(controller.getConfig().enabled).toBe(false);
    expect(controller.getCollectionEpoch()).toBe(0);
    expect(controller.record({
      level: "info",
      scope: "process",
      action: "discarded.while.disabled",
      source: { runtime: "openwork-server", component: "test" },
    })).toBeUndefined();

    controller.configure({ enabled: true, level: "debug", content: "hash" });
    expect(controller.getCollectionEpoch()).toBe(1);
    controller.configure({ scopes: ["lifecycle", "prompt"] });
    expect(controller.list().map((event) => event.action)).toEqual([
      "observability.enabled",
      "observability.config.changed",
    ]);

    controller.configure({ enabled: false });
    expect(controller.getConfig().enabled).toBe(false);
    expect(controller.list()).toEqual([]);
    controller.configure({ enabled: true });
    expect(controller.getCollectionEpoch()).toBe(2);
  });

  test("accepts only normalized event envelopes and never exposes its token in snapshots", () => {
    const controller = createServerObservabilityController({ enabled: true });
    const token = controller.getInternalToken();
    expect(token.length).toBeGreaterThan(32);
    expect(controller.acceptsInternalToken(token)).toBe(true);
    expect(controller.acceptsInternalToken(`${token}x`)).toBe(false);
    expect(controller.acceptsInternalToken(null)).toBe(false);

    expect(normalizeObservabilityEventInput({
      level: "info",
      scope: "prompt",
      action: "system-prompt.snapshot",
      source: { runtime: "opencode", component: "openwork-observability", operation: "system.transform" },
      observedAt: "2026-07-22T12:00:00.000Z",
      data: {
        blockCount: 1,
        collectionEpoch: 1,
        promptHash: "must-not-survive-metadata",
        rawBody: "private",
      },
    })).toMatchObject({
      source: { operation: "system.transform" },
      observedAt: "2026-07-22T12:00:00.000Z",
      data: { blockCount: 1, collectionEpoch: 1 },
    });
    expect(normalizeObservabilityEventInput({
      level: "info",
      scope: "made-up",
      action: "invalid",
      source: { runtime: "opencode", component: "observer" },
    })).toBeNull();

    controller.recordUnknown({
      level: "info",
      scope: "prompt",
      action: "system-prompt.snapshot",
      source: { runtime: "opencode", component: "openwork-observability" },
      data: {
        blockCount: 1,
        collectionEpoch: 1,
        rawBody: "private-body-outside-content",
      },
      content: { kind: "system-prompt", value: "private-body-inside-content" },
    });
    const serialized = JSON.stringify(controller.snapshot());
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain("private-body-outside-content");
    expect(serialized).not.toContain("private-body-inside-content");
  });

  test("rejects stale or untagged OpenCode observations across collection epochs", () => {
    const controller = createServerObservabilityController({ enabled: true });
    const observation = (collectionEpoch?: number) => ({
      level: "info",
      scope: "prompt",
      action: "system-prompt.snapshot",
      source: { runtime: "opencode", component: "openwork-observability" },
      data: {
        blockCount: 1,
        ...(collectionEpoch === undefined ? {} : { collectionEpoch }),
      },
    });

    expect(controller.getCollectionEpoch()).toBe(1);
    expect(controller.recordUnknown(observation())).toBeUndefined();
    expect(controller.recordUnknown(observation(0))).toBeUndefined();
    expect(controller.recordUnknown(observation(1))?.data).toMatchObject({ collectionEpoch: 1 });

    controller.configure({ enabled: false });
    controller.configure({ enabled: true });
    expect(controller.getCollectionEpoch()).toBe(2);
    expect(controller.recordUnknown(observation(1))).toBeUndefined();
    expect(controller.recordUnknown(observation(2))?.data).toMatchObject({ collectionEpoch: 2 });
  });

  test("supports a short lease override and expires collection without an owner heartbeat", async () => {
    const controller = createServerObservabilityController(
      { enabled: true, scopes: ["lifecycle"] },
      { leaseMs: 50 },
    );
    controller.record({
      level: "info",
      scope: "lifecycle",
      action: "before-expiry",
      source: { runtime: "openwork-server", component: "test" },
    });
    await Bun.sleep(80);
    expect(controller.getConfig().enabled).toBe(false);
    expect(controller.list()).toEqual([]);
  });
});
