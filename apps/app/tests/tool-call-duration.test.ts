import { describe, expect, test } from "bun:test";

import { formatElapsedSeconds } from "../src/lib/tool-call-duration";

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
});
