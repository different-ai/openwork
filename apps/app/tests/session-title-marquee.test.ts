import { describe, expect, test } from "bun:test";

import { isKeyboardFocus } from "../src/react-app/domains/session/sidebar/session-title-marquee";

describe("isKeyboardFocus", () => {
  test("holds the title scrolled only for keyboard focus", () => {
    expect(isKeyboardFocus({ matches: (selector) => selector === ":focus-visible" })).toBe(true);
    expect(isKeyboardFocus({ matches: () => false })).toBe(false);
  });

  test("falls back to focus when :focus-visible is unsupported", () => {
    expect(isKeyboardFocus({
      matches: () => {
        throw new Error("unsupported selector");
      },
    })).toBe(true);
  });
});
