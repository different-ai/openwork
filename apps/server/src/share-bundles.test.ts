import { describe, expect, test } from "bun:test";

import { ApiError } from "./errors.js";
import { normalizeSharedBundleFetchUrl, resolveTrustedSharedBundleFetchUrl } from "./share-bundles.js";

const VALID_SKILL_BUNDLE_ID = "01KNBQDQAK41VZSZDF5G9MW4MW";
const VALID_SKILL_SHARE_URL = `https://share.openworklabs.com/b/${VALID_SKILL_BUNDLE_ID}`;
const VALID_SKILL_DATA_URL = `${VALID_SKILL_SHARE_URL}/data`;

describe("normalizeSharedBundleFetchUrl", () => {
  test("rewrites human share pages to the canonical data endpoint", () => {
    const normalized = normalizeSharedBundleFetchUrl(new URL(`${VALID_SKILL_SHARE_URL}?format=json`));

    expect(normalized.toString()).toBe(VALID_SKILL_DATA_URL);
  });

  test("keeps existing data endpoints and strips redundant format", () => {
    const normalized = normalizeSharedBundleFetchUrl(new URL(`${VALID_SKILL_DATA_URL}?format=json&download=1`));

    expect(normalized.toString()).toBe(`${VALID_SKILL_DATA_URL}?download=1`);
  });
});

describe("resolveTrustedSharedBundleFetchUrl", () => {
  test("rebuilds fetch URLs from the configured publisher origin", () => {
    const resolved = resolveTrustedSharedBundleFetchUrl(`${VALID_SKILL_SHARE_URL}?download=1`);

    expect(resolved.toString()).toBe(VALID_SKILL_DATA_URL);
  });

  test("rejects bundle URLs that use another origin", () => {
    expect(() => resolveTrustedSharedBundleFetchUrl(`https://evil.example/b/${VALID_SKILL_BUNDLE_ID}`)).toThrow(
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
