import { describe, expect, test } from "bun:test";

import { ApiError } from "./errors.js";
import { normalizeSharedBundleFetchUrl, resolveTrustedSharedBundleFetchUrl } from "./share-bundles.js";

describe("normalizeSharedBundleFetchUrl", () => {
  test("rewrites human share pages to the canonical data endpoint", () => {
    const normalized = normalizeSharedBundleFetchUrl(
      new URL("https://share.openwork.software/b/01ARZ3NDEKTSV4RRFFQ69G5FAV?format=json"),
    );

    expect(normalized.toString()).toBe("https://share.openwork.software/b/01ARZ3NDEKTSV4RRFFQ69G5FAV/data");
  });

  test("keeps existing data endpoints and strips redundant format", () => {
    const normalized = normalizeSharedBundleFetchUrl(
      new URL("https://share.openwork.software/b/01ARZ3NDEKTSV4RRFFQ69G5FAV/data?format=json&download=1"),
    );

    expect(normalized.toString()).toBe(
      "https://share.openwork.software/b/01ARZ3NDEKTSV4RRFFQ69G5FAV/data?download=1",
    );
  });
});

describe("resolveTrustedSharedBundleFetchUrl", () => {
  test("rebuilds fetch URLs from the configured publisher origin", () => {
    const resolved = resolveTrustedSharedBundleFetchUrl("https://share.openworklabs.com/b/01ARZ3NDEKTSV4RRFFQ69G5FAV?download=1");

    expect(resolved.toString()).toBe("https://share.openworklabs.com/b/01ARZ3NDEKTSV4RRFFQ69G5FAV/data?format=json");
  });

  test("rejects bundle URLs that use another origin", () => {
    expect(() => resolveTrustedSharedBundleFetchUrl("https://evil.example/b/01ARZ3NDEKTSV4RRFFQ69G5FAV")).toThrow(
      new ApiError(
        400,
        "untrusted_bundle_url",
        "Shared bundle URLs must use the configured OpenWork publisher (https://share.openworklabs.com). Import only bundles from trusted sources.",
      ),
    );
  });

  test("rejects bundle URLs without a bundle id path", () => {
    expect(() => resolveTrustedSharedBundleFetchUrl("https://share.openworklabs.com/not-a-bundle")).toThrow(
      new ApiError(400, "invalid_bundle_url", "Shared bundle URL must point to a bundle id"),
    );
  });
});
