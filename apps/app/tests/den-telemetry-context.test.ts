import { afterAll, expect, mock, test } from "bun:test";
import type { DenSettings } from "../src/app/lib/den-types";

let settings: DenSettings = { baseUrl: "https://den.example.test", authToken: "token-a", activeOrgId: "org_a" };

mock.module("../src/app/lib/den", () => ({
  readDenSettings: () => settings,
  resolveDenBaseUrls: (input: { baseUrl: string; apiBaseUrl?: string }) => ({ apiBaseUrl: input.apiBaseUrl ?? input.baseUrl }),
}));
mock.module("../src/app/lib/runtime-env", () => ({ isDesktopRuntime: () => false }));
mock.module("../src/app/lib/desktop", () => ({ desktopFetchViaMain: () => Promise.reject(new Error("unused")) }));

const sent: { authorization: string; count: number }[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (_url: string | URL | Request, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  const body: unknown = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
  const events = typeof body === "object" && body !== null && "events" in body && Array.isArray(body.events) ? body.events : [];
  sent.push({ authorization: headers.get("authorization") ?? "", count: events.length });
  return new Response(null, { status: 204 });
}, { preconnect: originalFetch.preconnect });
afterAll(() => { globalThis.fetch = originalFetch; });

const { telemetryContextKey, trackTelemetryEvent } = await import("../src/app/lib/den-telemetry");

test("the context key changes with the account or the organization", () => {
  const base: DenSettings = { baseUrl: "https://den.example.test", authToken: "token-a", activeOrgId: "org_a" };
  expect(telemetryContextKey({ ...base, authToken: null })).toBeNull();
  expect(telemetryContextKey(base)).not.toBe(telemetryContextKey({ ...base, activeOrgId: "org_b" }));
  expect(telemetryContextKey(base)).not.toBe(telemetryContextKey({ ...base, authToken: "token-b" }));
});

test("events queued under one organization are never sent under another", async () => {
  trackTelemetryEvent("session.active", { sessionId: "recorded-in-org-a" });
  settings = { baseUrl: "https://den.example.test", authToken: "token-b", activeOrgId: "org_b" };
  for (let index = 0; index < 50; index += 1) trackTelemetryEvent("session.active", { sessionId: `org-b-${index}` });
  await Promise.resolve();
  expect(sent).toEqual([{ authorization: "Bearer token-b", count: 50 }]);
});
