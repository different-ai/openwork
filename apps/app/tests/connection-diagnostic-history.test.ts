import { describe, expect, test } from "bun:test";
import {
  CONNECTION_HISTORY_LIMIT,
  CONNECTION_HISTORY_TTL_MS,
  createConnectionDiagnosticHistory,
} from "../src/app/lib/connection-diagnostic-history";

describe("connection diagnostic history", () => {
  test("caps both events and tracker state and expires them on read without timers", () => {
    let now = 10_000;
    const history = createConnectionDiagnosticHistory(() => now);
    for (let i = 0; i < 2_000; i += 1) {
      history.createSource().transition("engine_connecting");
      now += 1;
    }
    const snapshot = history.read();
    expect(snapshot.retainedEntries).toBe(CONNECTION_HISTORY_LIMIT);
    expect(snapshot.trackedSources).toBe(CONNECTION_HISTORY_LIMIT);
    expect(snapshot.recent[0].source).toBe(1_501);
    now += CONNECTION_HISTORY_TTL_MS;
    expect(history.read().recent).toEqual([]);
    expect(history.read().trackedSources).toBe(0);
  });

  test("coalesces only repeated categorical events within a fixed five-second window", () => {
    let now = 0;
    const history = createConnectionDiagnosticHistory(() => now);
    history.record("den_request_http_failure", "failure", { httpStatus: 503 });
    now = 4_999;
    history.record("den_request_http_failure", "failure", { httpStatus: 503 });
    expect(history.read().recent).toMatchObject([{ at: 0, lastAt: 4_999, count: 2, httpStatus: 503 }]);
    now = 5_000;
    history.record("den_request_http_failure", "failure", { httpStatus: 503 });
    history.record("den_request_http_failure", "failure", { httpStatus: 401 });
    expect(history.read().retainedEntries).toBe(3);
    now = CONNECTION_HISTORY_TTL_MS;
    expect(history.read().recent.map((event) => event.at)).toEqual([5_000, 5_000]);
  });

  test("scopes recovery, tracks retry counts, and never lets another source recover a failure", () => {
    let now = 1_000;
    const history = createConnectionDiagnosticHistory(() => now);
    const failed = history.createSource();
    const healthy = history.createSource();
    failed.failed();
    now += 10;
    failed.attempt("den_session_retry");
    failed.failed();
    healthy.recovered("den_session_recovered");
    expect(history.read().recent.map((event) => event.kind)).toEqual(["retry"]);
    now += 10;
    failed.attempt("den_session_retry");
    failed.recovered("den_session_recovered");
    expect(history.read().recent.at(-1)).toMatchObject({
      reason: "den_session_recovered", kind: "recovered", durationMs: 20, retryCount: 2,
    });
    failed.recovered("den_session_recovered");
    expect(history.read().recent.filter((event) => event.kind === "recovered")).toHaveLength(1);
  });

  test("evicted or expired failure state cannot manufacture a recovery", () => {
    let now = 0;
    const history = createConnectionDiagnosticHistory(() => now);
    const source = history.createSource();
    source.failed();
    for (let i = 0; i < CONNECTION_HISTORY_LIMIT; i += 1) history.createSource().failed();
    source.recovered("den_session_recovered");
    expect(history.read().recent).toEqual([]);
    source.failed();
    now = CONNECTION_HISTORY_TTL_MS - 1;
    source.attempt("den_session_retry");
    now += 1;
    source.recovered("den_session_recovered");
    expect(history.read().recent.every((event) => event.kind !== "recovered")).toBe(true);
  });

  test("records exact blocker changes; unmount is ended, never recovery", () => {
    let now = 0;
    const history = createConnectionDiagnosticHistory(() => now);
    const source = history.createSource();
    source.blockers(["send_empty", "send_model_unavailable"]);
    now = 10;
    source.blockers(["send_model_unavailable", "send_empty"]);
    expect(history.read().retainedEntries).toBe(2);
    source.blockers(["send_empty"]);
    expect(history.read().recent.at(-1)).toMatchObject({ reason: "send_model_unavailable", kind: "cleared", durationMs: 10 });
    source.dispose();
    expect(history.read().recent.at(-1)).toMatchObject({ reason: "send_empty", kind: "ended" });
    expect(history.read().trackedSources).toBe(0);
    const count = history.read().retainedEntries;
    source.blockers([]);
    source.transition("engine_live");
    source.record("engine_live", "recovered");
    source.failed();
    source.attempt("engine_retry");
    source.recovered("engine_live");
    source.dispose();
    expect(history.read().retainedEntries).toBe(count);
    expect(history.read().trackedSources).toBe(0);
  });

  test("copies only allowlisted fields and rejects raw reason values at runtime", () => {
    const history = createConnectionDiagnosticHistory(() => 10);
    const metadata = {
      durationMs: 12,
      retryCount: 3,
      httpStatus: 503,
      url: "https://private.invalid/a?token=synthetic",
      path: "/private/folder",
      id: "private-id",
      token: "synthetic-token",
      body: "private-body",
      error: new Error("private-message"),
    };
    history.record("den_request_http_failure", "failure", metadata);
    const snapshot = history.read();
    expect(snapshot.recent[0]).toEqual({
      at: 10, lastAt: 10, count: 1, source: 0,
      reason: "den_request_http_failure", kind: "failure",
      durationMs: 12, retryCount: 3, httpStatus: 503,
    });
    Reflect.apply(history.record, undefined, ["private-message", "failure", metadata]);
    Reflect.apply(history.record, undefined, [{ toString: () => "engine_live", secret: "private" }, "state"]);
    Reflect.apply(history.record, undefined, ["engine_live", "private-message"]);
    expect(history.read().retainedEntries).toBe(1);
    snapshot.recent[0].count = 123;
    metadata.durationMs = 999;
    expect(history.read().recent[0].count).toBe(1);
    expect(history.read().recent[0].durationMs).toBe(12);
    const json = JSON.stringify(history.read());
    expect(json).not.toContain("private");
    expect(json).not.toContain("synthetic");
    expect(createConnectionDiagnosticHistory().read().recent).toEqual([]);
  });

  test("omits non-finite or invalid numeric metadata and bounds counters and durations", () => {
    const history = createConnectionDiagnosticHistory(() => 10);
    history.record("den_request_http_failure", "failure", { httpStatus: 900, retryCount: Infinity, durationMs: NaN });
    expect(JSON.stringify(history.read())).not.toContain("httpStatus");
    expect(JSON.stringify(history.read())).not.toContain("retryCount");
    history.record("engine_retry", "retry", { retryCount: 1e20, durationMs: 1e20 });
    expect(history.read().recent.at(-1)).toMatchObject({ retryCount: 1_000_000, durationMs: CONNECTION_HISTORY_TTL_MS });
  });
});
