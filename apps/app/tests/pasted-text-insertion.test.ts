import { describe, expect, test } from "bun:test";
import {
  PASTED_TEXT_INLINE_STYLE,
  splitPastedText,
} from "../src/react-app/domains/session/surface/composer/pasted-text";

describe("styled pasted-text insertion", () => {
  test("plans styled text nodes while preserving newlines and tabs", () => {
    expect(PASTED_TEXT_INLINE_STYLE).toContain("background-color");
    expect(splitPastedText("first\nsecond\tthird")).toEqual([
      { kind: "text", text: "first" },
      { kind: "line-break" },
      { kind: "text", text: "second" },
      { kind: "tab" },
      { kind: "text", text: "third" },
    ]);
  });
});
