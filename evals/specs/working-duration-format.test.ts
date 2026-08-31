import { expect } from "vitest";
import { test } from "@openwork/testkit";
import { formatElapsedSeconds } from "../../apps/app/src/lib/tool-call-duration";

test("live Working counters switch to minutes and seconds past one minute", () => {
  // Claim: once a run crosses 60 seconds, the live "Working …" counter reads
  // minutes and seconds (like the settled "Worked for 1m 55s" line), never a
  // raw ever-growing second count such as "403s".
  expect(formatElapsedSeconds(60)).toBe("1m 0s");
  expect(formatElapsedSeconds(115)).toBe("1m 55s");
  expect(formatElapsedSeconds(403)).toBe("6m 43s");
  for (let seconds = 60; seconds <= 3600; seconds += 1) {
    expect(formatElapsedSeconds(seconds)).not.toMatch(/^\d{2,}s$/);
  }

  // Negative half: below one minute the counter stays a plain second count,
  // so short runs keep their familiar "Working 12s" ticking.
  expect(formatElapsedSeconds(0)).toBe("0s");
  expect(formatElapsedSeconds(12)).toBe("12s");
  expect(formatElapsedSeconds(59)).toBe("59s");
});
