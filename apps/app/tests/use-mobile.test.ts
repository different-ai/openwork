import { describe, expect, test } from "bun:test";

import { getInitialIsMobile } from "../src/hooks/use-mobile";

describe("getInitialIsMobile", () => {
  test("reads the mobile media query synchronously", () => {
    let receivedQuery = "";

    const isMobile = getInitialIsMobile((query) => {
      receivedQuery = query;
      return { matches: true };
    });

    expect(receivedQuery).toBe("(max-width: 767px)");
    expect(isMobile).toBe(true);
  });

  test("defaults to desktop without window matchMedia", () => {
    expect(getInitialIsMobile()).toBe(false);
  });
});
