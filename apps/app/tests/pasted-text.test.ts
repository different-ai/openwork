import { describe, expect, test } from "bun:test";
import {
  PASTE_CHIP_CHAR_THRESHOLD,
  shouldCollapsePastedText,
} from "../src/react-app/domains/session/surface/composer/pasted-text";

describe("pasted text collapse policy", () => {
  test("keeps text at or below the threshold directly in the text field", () => {
    expect(PASTE_CHIP_CHAR_THRESHOLD).toBe(50);
    expect(shouldCollapsePastedText("a".repeat(PASTE_CHIP_CHAR_THRESHOLD - 1))).toBeFalse();
    expect(shouldCollapsePastedText("a".repeat(PASTE_CHIP_CHAR_THRESHOLD))).toBeFalse();
  });

  test("collapses text above the threshold into an expandable chip", () => {
    expect(shouldCollapsePastedText("a".repeat(PASTE_CHIP_CHAR_THRESHOLD + 1))).toBeTrue();
  });

  test("does not collapse standalone HTTP or HTTPS URLs", () => {
    expect(shouldCollapsePastedText(`https://example.com/${"a".repeat(PASTE_CHIP_CHAR_THRESHOLD)}`)).toBeFalse();
    expect(shouldCollapsePastedText(`http://example.com/${"b".repeat(PASTE_CHIP_CHAR_THRESHOLD)}`)).toBeFalse();
  });

  test("only exempts URLs that are the whole paste with no whitespace", () => {
    const longUrl = `https://example.com/${"c".repeat(PASTE_CHIP_CHAR_THRESHOLD)}`;
    expect(shouldCollapsePastedText(`${longUrl} `)).toBeTrue();
    expect(shouldCollapsePastedText(`Read ${longUrl}`)).toBeTrue();
  });

  test("does not collapse short multiline text", () => {
    expect(shouldCollapsePastedText("first\nsecond\nthird")).toBeFalse();
  });
});
