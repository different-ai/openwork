import { afterEach, describe, expect, test } from "bun:test";

import { requestJson, getUser, identifyPosthogUser, resetPosthogUser, trackPosthogEvent } from "../app/(den)/_lib/den-flow.ts";
import { setDenApiOriginOverride } from "../app/(den)/_lib/den-api-origin.ts";

const previousWindow = globalThis.window;
const previousFetch = globalThis.fetch;

afterEach(() => {
  setDenApiOriginOverride(null);
  globalThis.fetch = previousFetch;
  if (previousWindow === undefined) {
    delete globalThis.window;
  } else {
    globalThis.window = previousWindow;
  }
});

describe("Den flow stale session cleanup", () => {
  test("synthetic profiles suppress business events without suppressing the next real customer", () => {
    const captured = [];
    const identified = [];
    globalThis.window = { posthog: {
      capture: (...args) => captured.push(args),
      identify: (...args) => identified.push(args),
      reset: () => {},
    } };
    const synthetic = getUser({ user: { id: "synthetic", email: "synthetic@example.com", syntheticRunId: "openwork-live-123" } });
    identifyPosthogUser(synthetic);
    trackPosthogEvent("den_signup_completed");
    trackPosthogEvent("den_signout_completed");
    expect(captured).toEqual([]);
    expect(identified).toEqual([]);
    resetPosthogUser();
    const customer = getUser({ user: { id: "customer", email: "customer@example.com" } });
    identifyPosthogUser(customer);
    trackPosthogEvent("den_signup_completed");
    expect(identified).toHaveLength(1);
    expect(identified[0][0]).toBe("customer");
    expect(captured).toEqual([["den_signup_completed", { is_synthetic: false }]]);
  });
  test("clears Better Auth session cookies after /v1/me returns unauthorized", async () => {
    setDenApiOriginOverride("https://api.openworklabs.com");
    globalThis.window = {
      location: { origin: "https://app.openworklabs.com" },
      localStorage: { getItem: () => null },
    };
    const calls = [];
    globalThis.fetch = async (input, init) => {
      calls.push({ input: String(input), credentials: init?.credentials, method: init?.method });
      if (String(input) === "https://api.openworklabs.com/v1/me") {
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    const { response } = await requestJson("/v1/me", { method: "GET" }, 12000);

    expect(response.status).toBe(401);
    expect(calls).toEqual([
      { input: "https://api.openworklabs.com/v1/me", credentials: "include", method: "GET" },
      { input: "/api/auth/clear-session-cookie", credentials: "include", method: "POST" },
    ]);
  });
});
