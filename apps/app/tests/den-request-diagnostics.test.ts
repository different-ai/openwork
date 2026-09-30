import { afterEach, beforeEach, expect, jest, spyOn, test } from "bun:test";
import { createDenClient, DenApiError } from "../src/app/lib/den";
import { CONNECTION_HISTORY_TTL_MS, connectionDiagnosticHistory } from "../src/app/lib/connection-diagnostic-history";

let now = Date.now();
beforeEach(() => {
  now += CONNECTION_HISTORY_TTL_MS + 1;
  jest.useFakeTimers();
  spyOn(Date, "now").mockImplementation(() => now);
  connectionDiagnosticHistory.read();
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

const client = () => createDenClient({ baseUrl: "https://synthetic.invalid/private", token: "synthetic-secret" });

test("real Den request instrumentation records only HTTP status, without changing the thrown error", async () => {
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
    error: "private-code", message: "private-message", details: { token: "private-token" },
  }), { status: 503 }));
  try {
    await client().getSession();
    throw new Error("expected failure");
  } catch (error) {
    expect(error).toBeInstanceOf(DenApiError);
    expect(error).toMatchObject({ status: 503, code: "private-code", message: "private-message" });
  }
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(connectionDiagnosticHistory.read().recent).toMatchObject([{
    reason: "den_request_http_failure", kind: "failure", httpStatus: 503,
  }]);
  const json = JSON.stringify(connectionDiagnosticHistory.read());
  expect(json).not.toContain("private");
  expect(json).not.toContain("synthetic");
});

test("transport errors preserve identity and unrelated successes never claim recovery", async () => {
  const failure = new TypeError("synthetic-secret https://synthetic.invalid/private");
  const fetch = spyOn(globalThis, "fetch").mockRejectedValueOnce(failure);
  await expect(client().getSession()).rejects.toBe(failure);
  fetch.mockResolvedValue(new Response(JSON.stringify({ user: { id: "synthetic-user", email: "synthetic@example.invalid", name: "Synthetic" } }), { status: 200 }));
  await client().getSession();
  expect(connectionDiagnosticHistory.read().recent).toMatchObject([{
    reason: "den_request_transport_failure", kind: "failure",
  }]);
  expect(connectionDiagnosticHistory.read().retainedEntries).toBe(1);
  expect(JSON.stringify(connectionDiagnosticHistory.read())).not.toContain("synthetic");
});

test("the existing timeout is classified without inspecting its error string or retrying", async () => {
  const fetch = spyOn(globalThis, "fetch").mockImplementation(() => new Promise<Response>(() => {}));
  const outcome = client().getSession().then(() => null, (error: unknown) => error);
  now += 12_000;
  jest.advanceTimersByTime(12_000);
  expect(await outcome).toMatchObject({ message: "Request timed out." });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(connectionDiagnosticHistory.read().recent).toMatchObject([{
    reason: "den_request_timeout", kind: "failure", durationMs: 12_000,
  }]);
});
