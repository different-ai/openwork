import { describe, expect, test } from "bun:test";

import { DEFAULT_POSTHOG_KEY, resolvePosthogKey } from "../src/app/lib/analytics-key";

describe("analytics-key", () => {
  test("uses the default key for packaged release builds without an env override", () => {
    expect(resolvePosthogKey(undefined, false)).toBe(DEFAULT_POSTHOG_KEY);
  });

  test("stays silent for dev builds without an env override", () => {
    expect(resolvePosthogKey(undefined, true)).toBe("");
  });

  test("treats an explicit blank as disabled in prod builds", () => {
    expect(resolvePosthogKey("", false)).toBe("");
  });

  test("trims whitespace to disabled", () => {
    expect(resolvePosthogKey("  ", true)).toBe("");
  });

  test("uses an explicit key in dev builds", () => {
    expect(resolvePosthogKey("phc_custom", true)).toBe("phc_custom");
  });

  test("uses an explicit key in prod builds", () => {
    expect(resolvePosthogKey("phc_custom", false)).toBe("phc_custom");
  });
});
