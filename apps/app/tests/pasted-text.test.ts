import { describe, expect, test } from "bun:test";
import {
  shouldCollapsePastedText,
} from "../src/react-app/domains/session/surface/composer/pasted-text";

describe("pasted text collapse policy", () => {
  test("keeps text that fits without scrolling directly in the text field", () => {
    expect(shouldCollapsePastedText("Short paste", false)).toBeFalse();
  });

  test("collapses text that would make the composer scroll", () => {
    expect(shouldCollapsePastedText("Long paste", true)).toBeTrue();
  });

  test("does not collapse standalone HTTP or HTTPS URLs", () => {
    expect(shouldCollapsePastedText("https://example.com/long-url", true)).toBeFalse();
    expect(shouldCollapsePastedText("http://example.com/long-url", true)).toBeFalse();
  });

  test("only exempts URLs that are the whole paste with no whitespace", () => {
    const longUrl = "https://example.com/long-url";
    expect(shouldCollapsePastedText(`${longUrl} `, true)).toBeTrue();
    expect(shouldCollapsePastedText(`Read ${longUrl}`, true)).toBeTrue();
  });
});
