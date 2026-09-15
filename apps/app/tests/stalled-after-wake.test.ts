import { describe, expect, test } from "bun:test";

import {
  STALLED_AFTER_WAKE_GRACE_MS,
  WAKE_GAP_MS,
  detectWake,
  shouldStopStalledRunAfterWake,
} from "../src/react-app/domains/session/status/stalled-after-wake";

const wakeAt = 1_000_000;
const stalled = {
  wakeAt,
  now: wakeAt + STALLED_AFTER_WAKE_GRACE_MS,
  runActive: true,
  waiting: false,
  retrying: false,
  disconnected: false,
  toolInFlight: false,
  lastProgressAt: wakeAt - 5_000,
};

describe("detectWake", () => {
  test("a tick that arrives a sleep-sized gap late is a wake, throttled ticks are not", () => {
    expect(detectWake({ lastTickAt: 0, now: WAKE_GAP_MS })).toBe(true);
    expect(detectWake({ lastTickAt: 0, now: 5_000 })).toBe(false);
  });
});

describe("shouldStopStalledRunAfterWake", () => {
  test("stops a busy run that produced nothing for the whole grace period after waking", () => {
    expect(shouldStopStalledRunAfterWake(stalled)).toBe(true);
    expect(shouldStopStalledRunAfterWake({ ...stalled, now: wakeAt + STALLED_AFTER_WAKE_GRACE_MS - 1 })).toBe(false);
  });

  test("progress after the wake proves the socket survived", () => {
    expect(shouldStopStalledRunAfterWake({ ...stalled, lastProgressAt: wakeAt })).toBe(false);
    expect(shouldStopStalledRunAfterWake({ ...stalled, lastProgressAt: wakeAt + 1 })).toBe(false);
  });

  test("never stops without a wake, or when silence has a legitimate owner", () => {
    expect(shouldStopStalledRunAfterWake({ ...stalled, wakeAt: null })).toBe(false);
    expect(shouldStopStalledRunAfterWake({ ...stalled, runActive: false })).toBe(false);
    expect(shouldStopStalledRunAfterWake({ ...stalled, waiting: true })).toBe(false);
    expect(shouldStopStalledRunAfterWake({ ...stalled, retrying: true })).toBe(false);
    expect(shouldStopStalledRunAfterWake({ ...stalled, disconnected: true })).toBe(false);
    expect(shouldStopStalledRunAfterWake({ ...stalled, toolInFlight: true })).toBe(false);
  });
});
