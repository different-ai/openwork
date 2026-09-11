import { describe, expect, spyOn, test } from "bun:test";
import type { DynamicToolUIPart } from "ai";

import { formatElapsedSeconds, getToolCallStartedAt, trackToolCallDuration } from "../src/lib/tool-call-duration";

function runningPart(toolCallId: string, callProviderMetadata?: DynamicToolUIPart["callProviderMetadata"]): DynamicToolUIPart {
  return {
    type: "dynamic-tool",
    toolName: "task",
    toolCallId,
    state: "input-available",
    input: {},
    callProviderMetadata,
  };
}

describe("formatElapsedSeconds", () => {
  test("shows whole seconds below a minute", () => {
    expect(formatElapsedSeconds(0)).toBe("0s");
    expect(formatElapsedSeconds(12)).toBe("12s");
    expect(formatElapsedSeconds(59)).toBe("59s");
  });

  test("switches to minutes and seconds once a minute is crossed", () => {
    expect(formatElapsedSeconds(60)).toBe("1m 0s");
    expect(formatElapsedSeconds(115)).toBe("1m 55s");
    expect(formatElapsedSeconds(403)).toBe("6m 43s");
  });

  test("prefers native start time and leaves restored missing timing unknown", () => {
    const clock = spyOn(Date, "now").mockReturnValue(62_000);
    try {
      const persisted = runningPart("persisted-start", {
        opencode: { partId: "part-persisted" },
        openwork: { toolStartedAt: 1_000 },
      });
      expect(getToolCallStartedAt(persisted)).toBe(1_000);
      trackToolCallDuration(persisted);
      expect(getToolCallStartedAt(persisted)).toBe(1_000);
      expect(getToolCallStartedAt(runningPart("unknown-start", {
        opencode: { partId: "part-unknown" },
      }))).toBeNull();
      expect(getToolCallStartedAt(runningPart("optimistic-start"))).toBe(62_000);
    } finally {
      clock.mockRestore();
    }
  });
});
