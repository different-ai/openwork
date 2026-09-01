/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  OVERFLOW_FADE_TOLERANCE_PX,
  OverflowFadeLabel,
  resolveOverflowFade,
} from "../src/react-app/domains/session/sidebar/overflow-fade-label";

describe("overflow fade label", () => {
  test("fades only when the text is wider than its box", () => {
    expect(resolveOverflowFade({ clientWidth: 180, scrollWidth: 96 })).toBe(false);
    expect(resolveOverflowFade({ clientWidth: 180, scrollWidth: 180 })).toBe(false);
    expect(resolveOverflowFade({ clientWidth: 180, scrollWidth: 180 + OVERFLOW_FADE_TOLERANCE_PX })).toBe(false);
    expect(resolveOverflowFade({ clientWidth: 180, scrollWidth: 182 })).toBe(true);
    expect(resolveOverflowFade({ clientWidth: 0, scrollWidth: 0 })).toBe(false);
  });

  test("renders a full-width clipped box with no fade before measurement", () => {
    const markup = renderToStaticMarkup(
      <button type="button">
        <OverflowFadeLabel data-sidebar-workspace-title>Blue Yonder</OverflowFadeLabel>
      </button>,
    );

    expect(markup).toContain("Blue Yonder");
    expect(markup).toContain("data-sidebar-workspace-title");
    expect(markup).toContain("data-overflow-fade-label");
    expect(markup).toContain("w-full");
    expect(markup).toContain("overflow-hidden");
    expect(markup).not.toContain("ow-fade-truncate");
    expect(markup).not.toContain("data-overflowing");
  });
});
