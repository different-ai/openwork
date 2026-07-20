import { describe, expect, test } from "bun:test";

import { resolveOpenWorkBuildIdentifier } from "../src/app/lib/build-identifier";

describe("build identifier", () => {
  test("prioritizes a release version over the SHA", () => {
    expect(resolveOpenWorkBuildIdentifier({
      releaseVersion: " 1.4.2 ",
      buildSha: "abcdef1234567890",
    })).toBe("v1.4.2");
  });

  test("normalizes release values while preserving an existing v prefix", () => {
    expect(resolveOpenWorkBuildIdentifier({ releaseVersion: "1.4.2" })).toBe("v1.4.2");
    expect(resolveOpenWorkBuildIdentifier({ releaseVersion: " v2.0.0 " })).toBe("v2.0.0");
  });

  test("falls back to a shortened SHA", () => {
    expect(resolveOpenWorkBuildIdentifier({ buildSha: " abcdef123456 " })).toBe("abcdef1");
  });

  test("returns null when release and SHA values are missing", () => {
    expect(resolveOpenWorkBuildIdentifier({})).toBeNull();
    expect(resolveOpenWorkBuildIdentifier({
      releaseVersion: " ",
      buildSha: null,
    })).toBeNull();
  });
});
