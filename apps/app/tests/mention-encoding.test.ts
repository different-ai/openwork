import { describe, expect, test } from "bun:test";

import { decodeComposerMentionValue, encodeComposerMentionValue } from "../src/react-app/domains/session/surface/composer/mention-encoding";

describe("mention-encoding", () => {
  test("round-trips paths with spaces", () => {
    const value = "docs/foo bar.md";
    expect(decodeComposerMentionValue(encodeComposerMentionValue(value))).toBe(value);
    expect(encodeComposerMentionValue(value)).toBe("docs/foo%20bar.md");
  });

  test("preserves literal percent-encoded sequences in paths", () => {
    const value = "docs/foo%20bar.md";
    expect(encodeComposerMentionValue(value)).toBe("docs/foo%2520bar.md");
    expect(decodeComposerMentionValue("docs/foo%2520bar.md")).toBe(value);
  });

  test("round-trips percent signs", () => {
    const value = "docs/100% done.md";
    expect(decodeComposerMentionValue(encodeComposerMentionValue(value))).toBe(value);
  });
});
