import { describe, expect, test } from "bun:test";

import { toolCallIdsKey } from "../src/components/chat/current-tool-lifecycle-context";

describe("current tool lifecycle context", () => {
  test("gives reordered tool identifiers the same context key", () => {
    expect(toolCallIdsKey(new Set(["tool-a", "tool-b"]))).toBe(toolCallIdsKey(new Set(["tool-b", "tool-a"])));
  });

  test("changes the context key when membership changes", () => {
    expect(toolCallIdsKey(new Set(["tool-a"]))).not.toBe(toolCallIdsKey(new Set(["tool-b"])));
  });
});
