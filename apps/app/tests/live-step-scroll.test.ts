import { describe, expect, test } from "bun:test";

import {
  isLiveStepAtBottom,
  pinnedAfterUserScroll,
  pinnedAfterWheel,
  shouldFollowLiveStepGrowth,
} from "../src/components/chat/live-step-scroll";

describe("live step scroll", () => {
  test("follows streaming growth only while the user is pinned to the tail", () => {
    expect(shouldFollowLiveStepGrowth({ isLive: true, pinned: true })).toBe(true);
    expect(shouldFollowLiveStepGrowth({ isLive: true, pinned: false })).toBe(false);
    expect(shouldFollowLiveStepGrowth({ isLive: false, pinned: true })).toBe(false);
  });

  test("a wheel-up gesture unpins even when the list is still at the bottom", () => {
    expect(pinnedAfterWheel({ deltaY: -12, pinned: true, atBottom: true })).toBe(false);
    expect(pinnedAfterUserScroll(false)).toBe(false);
    expect(pinnedAfterUserScroll(true)).toBe(true);
  });

  test("treats a small tail gap as still at the bottom", () => {
    expect(isLiveStepAtBottom({ scrollHeight: 800, scrollTop: 284, clientHeight: 520 })).toBe(true);
    expect(isLiveStepAtBottom({ scrollHeight: 800, scrollTop: 100, clientHeight: 520 })).toBe(false);
  });
});
