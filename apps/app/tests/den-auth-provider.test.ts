import { describe, expect, test } from "bun:test";

import { DenApiError } from "../src/app/lib/den";
import { connectionDiagnosticHistory } from "../src/app/lib/connection-diagnostic-history";
import {
  DEN_AUTH_SIGNAL_RETRY_COOLDOWN_MS,
  hasRetainedDenSession,
  isDenSessionRestoring,
  resolveDenActiveOrganizationWithRetry,
  resolveDenAuthFailureStatus,
  shouldRetryDenAuthOnSignal,
} from "../src/react-app/domains/cloud/den-auth-provider";

const resolvedOrganization = {
  id: "org_invited",
  name: "Invited organization",
  slug: "invited-organization",
  role: "member",
};

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

describe("isDenSessionRestoring", () => {
  test("a retained account without a confirmed user is restoring, never signed out", () => {
    // Initial check in flight.
    expect(isDenSessionRestoring({ status: "checking", hasUser: false })).toBe(true);
    // First check failed transiently (local restart, control-plane blip)
    // before any user was confirmed: the account UI must keep showing the
    // restoring state instead of flashing "Sign in".
    expect(isDenSessionRestoring({ status: "unavailable", hasUser: false })).toBe(true);
  });

  test("settled sessions are not restoring", () => {
    expect(isDenSessionRestoring({ status: "signed_in", hasUser: true })).toBe(false);
    // A previously confirmed user stays rendered as the account during an
    // availability blip.
    expect(isDenSessionRestoring({ status: "unavailable", hasUser: true })).toBe(false);
    expect(isDenSessionRestoring({ status: "signed_out", hasUser: false })).toBe(false);
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

describe("resolveDenActiveOrganizationWithRetry", () => {
  test("recovers when an invited organization is temporarily unavailable", async () => {
    let attempts = 0;
    const waits: number[] = [];

    const result = await resolveDenActiveOrganizationWithRetry(
      async () => {
        attempts += 1;
        if (attempts === 1) throw new TypeError("Failed to fetch");
        if (attempts === 2) return null;
        return resolvedOrganization;
      },
      async (delayMs) => {
        waits.push(delayMs);
      },
    );

    expect(result).toEqual(resolvedOrganization);
    expect(attempts).toBe(3);
    expect(waits).toEqual([200, 600]);
    const history = connectionDiagnosticHistory.read();
    const recovered = history.recent.findLast((event) => event.reason === "den_org_recovered");
    expect(recovered).toMatchObject({ kind: "recovered", retryCount: 2 });
    const events = history.recent.filter((event) => event.source === recovered?.source);
    expect(events.map((event) => event.reason)).toEqual([
      "den_org_unresolved", "den_org_retry", "den_org_unresolved", "den_org_retry", "den_org_recovered",
    ]);
    expect(history.trackedSources).toBe(0);
    expect(JSON.stringify(events)).not.toContain(resolvedOrganization.id);
    expect(JSON.stringify(events)).not.toContain("Failed to fetch");
  });
});
