import { describe, expect, test } from "bun:test";
import {
  PASTE_CHIP_CHAR_THRESHOLD,
  shouldCollapsePastedText,
} from "../src/react-app/domains/session/surface/composer/pasted-text";

describe("pasted text collapse policy", () => {
  test("keeps text at or below the threshold directly in the text field", () => {
    expect(shouldCollapsePastedText("a".repeat(PASTE_CHIP_CHAR_THRESHOLD - 1))).toBeFalse();
    expect(shouldCollapsePastedText("a".repeat(PASTE_CHIP_CHAR_THRESHOLD))).toBeFalse();
  });

  test("collapses text above the threshold into an expandable chip", () => {
    expect(shouldCollapsePastedText("a".repeat(PASTE_CHIP_CHAR_THRESHOLD + 1))).toBeTrue();
  });

  test("does not collapse short multiline text", () => {
    expect(shouldCollapsePastedText("first\nsecond\nthird")).toBeFalse();
  });
});
