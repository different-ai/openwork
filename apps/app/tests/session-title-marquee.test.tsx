/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  resolveSessionTitleTooltip,
  SessionTitle,
} from "../src/react-app/domains/session/sidebar/session-title";
import {
  createSessionTitleMarqueeController,
  SESSION_TITLE_HOVER_DELAY_MS,
  SESSION_TITLE_SPEED_PX_PER_SECOND,
  type SessionTitleMarqueeState,
} from "../src/react-app/domains/session/sidebar/session-title-marquee";

type TimerCallback = () => void;

function setup(widths: { viewport: number; text: number }, reducedMotion = false) {
  const states: SessionTitleMarqueeState[] = [];
  const timers = new Map<number, TimerCallback>();
  let timerId = 0;
  let motionReduced = reducedMotion;
  const viewport = { clientWidth: widths.viewport, scrollWidth: widths.viewport };
  const text = { clientWidth: widths.text, scrollWidth: widths.text };
  const controller = createSessionTitleMarqueeController({
    getReducedMotion: () => motionReduced,
    getText: () => text,
    getViewport: () => viewport,
    onChange: (state) => states.push(state),
    setTimer: (callback, delayMs) => {
      expect(delayMs).toBe(SESSION_TITLE_HOVER_DELAY_MS);
      timerId += 1;
      timers.set(timerId, callback);
      return timerId;
    },
    clearTimer: (id) => timers.delete(id),
  });

  return {
    controller,
    latest: () => states.at(-1),
    pendingTimers: () => timers.size,
    runTimer: () => {
      const entry = timers.entries().next().value;
      if (!entry) return;
      const [id, callback] = entry;
      timers.delete(id);
      callback();
    },
    setReducedMotion: (value: boolean) => {
      motionReduced = value;
    },
    text,
    viewport,
  };
}

describe("session title marquee", () => {
  test("never moves a fitting title", () => {
    const subject = setup({ viewport: 160, text: 140 });
    subject.controller.setIntent("focus");

    expect(subject.latest()).toEqual({
      durationMs: 180,
      moving: false,
      offsetPx: 0,
      overflowing: false,
    });
  });

  test("delays pointer intent and moves overflow once at a distance-based speed", () => {
    const subject = setup({ viewport: 120, text: 200 });
    subject.controller.setIntent("hover");

    expect(subject.latest()?.moving).toBe(false);
    expect(subject.pendingTimers()).toBe(1);
    subject.runTimer();

    expect(subject.latest()).toEqual({
      durationMs: (80 / SESSION_TITLE_SPEED_PX_PER_SECOND) * 1_000,
      moving: true,
      offsetPx: 80,
      overflowing: true,
    });
  });

  test("keyboard focus activates immediately and exit returns smoothly to rest", () => {
    const subject = setup({ viewport: 100, text: 164 });
    subject.controller.setIntent("focus");
    expect(subject.latest()?.moving).toBe(true);
    expect(subject.pendingTimers()).toBe(0);

    subject.controller.setIntent(null);
    expect(subject.latest()).toMatchObject({ durationMs: 180, moving: false, offsetPx: 0 });
  });

  test("cleanup cancels delayed activation", () => {
    const subject = setup({ viewport: 100, text: 164 });
    subject.controller.setIntent("hover");
    subject.controller.destroy();

    expect(subject.pendingTimers()).toBe(0);
    subject.runTimer();
    expect(subject.latest()?.moving).toBe(false);
  });

  test("recalculates for title, resize, nesting, and hover-action spacing", () => {
    const subject = setup({ viewport: 140, text: 220 });
    subject.controller.setIntent("focus");
    expect(subject.latest()?.offsetPx).toBe(80);

    subject.text.scrollWidth = 252;
    subject.controller.measure();
    expect(subject.latest()?.offsetPx).toBe(112);

    subject.text.scrollWidth = 220;
    subject.viewport.clientWidth = 110;
    subject.controller.measure();
    expect(subject.latest()).toMatchObject({ offsetPx: 110, durationMs: 3438, moving: true });

    subject.viewport.clientWidth = 230;
    subject.controller.measure();
    expect(subject.latest()).toMatchObject({ offsetPx: 0, moving: false, overflowing: false });
  });

  test("reduced motion stays truncated and measurable without moving", () => {
    const subject = setup({ viewport: 100, text: 180 }, true);
    subject.controller.setIntent("focus");
    expect(subject.latest()).toMatchObject({ moving: false, overflowing: true });

    subject.setReducedMotion(false);
    subject.controller.measure();
    expect(subject.latest()).toMatchObject({ moving: true, offsetPx: 80 });
  });

  test("keeps the full accessible row name and fitting-title tooltip", () => {
    const markup = renderToStaticMarkup(
      <button aria-label="A complete title, unread">
        <SessionTitle intent={null} title="A complete title" tooltip="A complete title — Workspace" />
      </button>,
    );

    expect(markup).toContain('aria-label="A complete title, unread"');
    expect(markup).toContain(
      'aria-hidden="true" class="inline-block" data-session-title-text="true" title="A complete title — Workspace"',
    );
    expect(markup).not.toContain("ow-session-title-moving");
  });

  test("suppresses the native tooltip while overflow is revealed", () => {
    expect(resolveSessionTitleTooltip({
      overflowing: true,
      reducedMotion: false,
      tooltip: "A complete title — Workspace",
    })).toBeUndefined();
    expect(resolveSessionTitleTooltip({
      overflowing: false,
      reducedMotion: false,
      tooltip: "A complete title — Workspace",
    })).toBe("A complete title — Workspace");
    expect(resolveSessionTitleTooltip({
      overflowing: true,
      reducedMotion: true,
      tooltip: "A complete title — Workspace",
    })).toBe("A complete title — Workspace");
  });
});
