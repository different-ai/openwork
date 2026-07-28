import { describe, expect, test } from "bun:test";
import {
  splitPastedText,
} from "../src/react-app/domains/session/surface/composer/pasted-text";

describe("plain pasted-text insertion", () => {
  test("plans normal text nodes while preserving newlines and tabs", () => {
    expect(splitPastedText("first\nsecond\tthird")).toEqual([
      { kind: "text", text: "first" },
      { kind: "line-break" },
      { kind: "text", text: "second" },
      { kind: "tab" },
      { kind: "text", text: "third" },
    ]);
  });
});
