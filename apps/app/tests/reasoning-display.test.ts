import { describe, expect, test } from "bun:test";

import { DEFAULT_SHOW_THINKING } from "../src/react-app/kernel/local-provider";

// The legacy SessionTranscript markup test was removed with the legacy
// message list (#2016). Reasoning markup for the current transcript is
// covered by the UI evals (evals/) which drive the real app.
describe("reasoning display", () => {
  test("defaults reasoning visibility on", () => {
    expect(DEFAULT_SHOW_THINKING).toBe(true);
  });
});
