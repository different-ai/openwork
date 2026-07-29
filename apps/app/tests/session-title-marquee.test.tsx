import { afterEach, describe, expect, jest, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  SessionTitleMarquee,
  getSessionTitleMarqueeMetrics,
  scheduleSessionTitlePointerIntent,
  shouldMoveSessionTitle,
} from "../src/react-app/domains/session/sidebar/session-title-marquee";

afterEach(() => {
  jest.useRealTimers();
});

describe("session title marquee", () => {
  test("measures only genuine overflow at a constant readable speed", () => {
    expect(getSessionTitleMarqueeMetrics(160, 160)).toEqual({ distance: 0, durationMs: 0 });
    expect(getSessionTitleMarqueeMetrics(160.4, 160)).toEqual({ distance: 0, durationMs: 0 });
    expect(getSessionTitleMarqueeMetrics(232, 160)).toEqual({ distance: 72, durationMs: 2_000 });
    expect(getSessionTitleMarqueeMetrics(304, 160)).toEqual({ distance: 144, durationMs: 4_000 });
  });

  test("recalculates distance when nesting, resizing, or action spacing changes the viewport", () => {
    expect(getSessionTitleMarqueeMetrics(240, 200).distance).toBe(40);
    expect(getSessionTitleMarqueeMetrics(240, 184).distance).toBe(56);
    expect(getSessionTitleMarqueeMetrics(240, 152).distance).toBe(88);
    expect(getSessionTitleMarqueeMetrics(240, 260).distance).toBe(0);
  });

  test("activates for delayed pointer intent or keyboard focus, but not reduced motion", () => {
    expect(shouldMoveSessionTitle(80, false, false, false)).toBe(false);
    expect(shouldMoveSessionTitle(80, true, false, false)).toBe(true);
    expect(shouldMoveSessionTitle(80, false, true, false)).toBe(true);
    expect(shouldMoveSessionTitle(80, true, true, true)).toBe(false);
    expect(shouldMoveSessionTitle(0, true, true, false)).toBe(false);
  });

  test("delays hover activation and cleanup cancels pending intent", () => {
    jest.useFakeTimers();
    let activations = 0;
    const cancel = scheduleSessionTitlePointerIntent(() => activations += 1);

    jest.advanceTimersByTime(499);
    expect(activations).toBe(0);
    cancel();
    jest.advanceTimersByTime(1);
    expect(activations).toBe(0);

    scheduleSessionTitlePointerIntent(() => activations += 1);
    jest.advanceTimersByTime(500);
    expect(activations).toBe(1);
  });

  test("keeps the full tooltip and accessible text in stable single-line markup", () => {
    const title = "A complete and deliberately long session title";
    const html = renderToStaticMarkup(
      <SessionTitleMarquee keyboardFocused={false} title={title} tooltip={title} />,
    );

    expect(html).toContain("data-session-title-viewport");
    expect(html).toContain("overflow-hidden whitespace-nowrap");
    expect(html).toContain(`title="${title}"`);
    expect(html).toContain(title);
    expect(html).not.toContain("tabindex");
  });
});
