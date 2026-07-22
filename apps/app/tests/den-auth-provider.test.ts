import { describe, expect, test } from "bun:test";

import { DenApiError } from "../src/app/lib/den";
import {
  DEN_AUTH_SIGNAL_RETRY_COOLDOWN_MS,
  hasRetainedDenSession,
  resolveDenAuthFailureStatus,
  shouldRetryDenAuthOnSignal,
} from "../src/react-app/domains/cloud/den-auth-provider";

describe("resolveDenAuthFailureStatus", () => {
  test("only treats a confirmed unauthorized response as signed out", () => {
    expect(resolveDenAuthFailureStatus(new DenApiError(401, "unauthorized", "Unauthorized"))).toBe(
      "signed_out",
    );
    expect(resolveDenAuthFailureStatus(new DenApiError(403, "forbidden", "Forbidden"))).toBe(
      "unavailable",
    );
  });

  test("keeps the session for server, timeout, and network failures", () => {
    expect(resolveDenAuthFailureStatus(new DenApiError(503, "unavailable", "Unavailable"))).toBe(
      "unavailable",
    );
    expect(resolveDenAuthFailureStatus(new Error("Request timed out."))).toBe("unavailable");
    expect(resolveDenAuthFailureStatus(new TypeError("Failed to fetch"))).toBe("unavailable");
  });
});

describe("retained Den sessions", () => {
  test("keeps signed-in behavior while Cloud availability is unknown", () => {
    expect(hasRetainedDenSession("signed_in")).toBe(true);
    expect(hasRetainedDenSession("unavailable")).toBe(true);
    expect(hasRetainedDenSession("checking")).toBe(false);
    expect(hasRetainedDenSession("signed_out")).toBe(false);
  });
});

describe("shouldRetryDenAuthOnSignal", () => {
  test("retries an unavailable session when connectivity returns", () => {
    expect(
      shouldRetryDenAuthOnSignal({
        status: "unavailable",
        online: true,
        now: 1_000,
        lastAttemptAt: null,
      }),
    ).toBe(true);
  });

  test("does not retry offline, healthy, or inside the signal cooldown", () => {
    expect(
      shouldRetryDenAuthOnSignal({
        status: "unavailable",
        online: false,
        now: 1_000,
        lastAttemptAt: null,
      }),
    ).toBe(false);
    expect(
      shouldRetryDenAuthOnSignal({
        status: "signed_in",
        online: true,
        now: 1_000,
        lastAttemptAt: null,
      }),
    ).toBe(false);
    expect(
      shouldRetryDenAuthOnSignal({
        status: "unavailable",
        online: true,
        now: 1_000 + DEN_AUTH_SIGNAL_RETRY_COOLDOWN_MS - 1,
        lastAttemptAt: 1_000,
      }),
    ).toBe(false);
    expect(
      shouldRetryDenAuthOnSignal({
        status: "unavailable",
        online: true,
        now: 1_000 + DEN_AUTH_SIGNAL_RETRY_COOLDOWN_MS,
        lastAttemptAt: 1_000,
      }),
    ).toBe(true);
  });
});
