import { describe, expect, test } from "bun:test";
import { feedListOffset, feedRowRange } from "../src/react-app/domains/session/sidebar/virtual-feed-rows";

const viewport = { startIndex: 100, endIndex: 110, overscan: 6, count: 10_000 };

describe("Feed mounted range", () => {
  test("mounts only the viewport and overscan regardless of history size", () => {
    expect(feedRowRange(viewport, -1, -1)).toEqual(Array.from({ length: 23 }, (_, i) => i + 94));
  });

  test("retains an offscreen drag source so scrolling cannot cancel a drag", () => {
    const range = feedRowRange(viewport, 2, -1);
    expect(range[0]).toBe(2);
    expect(range).toHaveLength(24);
  });

  test("keeps focus and adjacent Tab destinations mounted even outside overscan", () => {
    const range = feedRowRange(viewport, -1, 30);
    expect(range.slice(0, 3)).toEqual([29, 30, 31]);
    expect(range).toHaveLength(26);
  });

  test("bounds retained neighbours at both ends and ignores stale indexes", () => {
    expect(feedRowRange(viewport, -1, 0).slice(0, 2)).toEqual([0, 1]);
    expect(feedRowRange(viewport, -1, 9999).slice(-2)).toEqual([9998, 9999]);
    expect(feedRowRange(viewport, 10_000, 10_000)).toEqual(feedRowRange(viewport, -1, -1));
  });

  test("deduplicates retained rows that are already in the viewport", () => {
    expect(feedRowRange(viewport, 100, 101)).toEqual(feedRowRange(viewport, -1, -1));
  });
});

describe("Feed list offset", () => {
  test("is how far the list has scrolled past the sidebar top, read from live positions", () => {
    expect(feedListOffset(100, 364)).toBe(-264);
    // Content above the list shrank by 700px without a scroll: the offset follows the list.
    expect(feedListOffset(100, -336)).toBe(436);
  });
});
