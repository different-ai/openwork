import { describe, expect, test } from "bun:test";

import { resolveDenTelemetryIngestUrl } from "../src/app/lib/den-telemetry";

describe("Den telemetry endpoint", () => {
  test("derives the API base URL from the Den web base", () => {
    expect(resolveDenTelemetryIngestUrl({
      baseUrl: "https://app.den.test",
      apiBaseUrl: "https://api.den.test",
      authToken: "tok_test",
      activeOrgId: null,
      activeOrgSlug: null,
      activeOrgName: null,
    })).toBe("https://api.den.test/v1/telemetry/ingest");
  });

  test("uses the nested hosted API default for hosted desktop telemetry", () => {
    expect(resolveDenTelemetryIngestUrl({
      baseUrl: "https://app.openworklabs.com",
      apiBaseUrl: "https://api.app.openworklabs.com",
      authToken: "tok_test",
      activeOrgId: null,
      activeOrgSlug: null,
      activeOrgName: null,
    })).toBe("https://api.app.openworklabs.com/v1/telemetry/ingest");
  });

  test("returns null without an auth token", () => {
    expect(resolveDenTelemetryIngestUrl({
      baseUrl: "https://app.den.test",
      apiBaseUrl: "https://api.den.test",
      authToken: null,
      activeOrgId: null,
      activeOrgSlug: null,
      activeOrgName: null,
    })).toBeNull();
  });
});
