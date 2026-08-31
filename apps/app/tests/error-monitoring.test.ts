import { describe, expect, test } from "bun:test";

import {
  buildSentryEnvelope,
  buildWebErrorEvent,
  parseSentryDsn,
  sanitizePageUrl,
  shouldMonitorWebErrors,
} from "../src/app/lib/error-monitoring";

const DSN = "https://publickey123@o123456.ingest.us.sentry.io/4500000000000000";

describe("parseSentryDsn", () => {
  test("derives the envelope ingest URL from a valid DSN", () => {
    expect(parseSentryDsn(DSN)).toEqual({
      envelopeUrl:
        "https://o123456.ingest.us.sentry.io/api/4500000000000000/envelope/?sentry_key=publickey123&sentry_version=7",
    });
  });

  test("rejects blanks, non-DSN strings, and unreplaced Vite placeholders", () => {
    expect(parseSentryDsn("")).toBeNull();
    expect(parseSentryDsn("   ")).toBeNull();
    expect(parseSentryDsn("not-a-dsn")).toBeNull();
    expect(parseSentryDsn("%VITE_OPENWORK_SENTRY_DSN%")).toBeNull();
    expect(parseSentryDsn("http://key@host/1")).toBeNull();
  });
});

describe("shouldMonitorWebErrors", () => {
  test("enables only for a web deployment outside Electron with a valid DSN", () => {
    expect(shouldMonitorWebErrors({ dsn: DSN, deployment: "web", electronRuntime: false })).toBe(true);
  });

  test("stays off for desktop builds even with a DSN", () => {
    expect(shouldMonitorWebErrors({ dsn: DSN, deployment: "desktop", electronRuntime: false })).toBe(false);
  });

  test("stays off inside Electron even for a web-flavored bundle", () => {
    expect(shouldMonitorWebErrors({ dsn: DSN, deployment: "web", electronRuntime: true })).toBe(false);
  });

  test("stays off without a usable DSN", () => {
    expect(shouldMonitorWebErrors({ dsn: "", deployment: "web", electronRuntime: false })).toBe(false);
    expect(
      shouldMonitorWebErrors({ dsn: "%VITE_OPENWORK_SENTRY_DSN%", deployment: "web", electronRuntime: false }),
    ).toBe(false);
  });
});

describe("sanitizePageUrl", () => {
  test("strips credential-bearing query strings and fragments", () => {
    expect(
      sanitizePageUrl("https://app.openworklabs.com/signin?grant=secret-grant&openworkToken=tok#accessToken=at"),
    ).toBe("https://app.openworklabs.com/signin");
    expect(sanitizePageUrl("https://app.openworklabs.com/chat/abc?accessToken=x")).toBe(
      "https://app.openworklabs.com/chat/abc",
    );
  });

  test("returns empty for unparseable input instead of leaking it", () => {
    expect(sanitizePageUrl("not a url")).toBe("");
    expect(sanitizePageUrl("")).toBe("");
  });
});

describe("buildWebErrorEvent", () => {
  test("carries only error identity and coarse context", () => {
    const event = buildWebErrorEvent({
      type: "TypeError",
      message: "x is not a function",
      stack: "TypeError: x is not a function\n  at boot",
      url: "https://app.openworklabs.com/",
      release: "abc123",
      phase: "boot",
    });
    expect(event.event_id).toMatch(/^[0-9a-f]{32}$/);
    expect(event.platform).toBe("javascript");
    expect(event.level).toBe("error");
    expect(event.environment).toBe("web");
    expect(event.release).toBe("abc123");
    expect(event.tags).toEqual({ boot_phase: "boot" });
    expect(event.request).toEqual({ url: "https://app.openworklabs.com/" });
    expect(event.exception.values).toEqual([{ type: "TypeError", value: "x is not a function" }]);
    expect(event.extra).toEqual({ stack: "TypeError: x is not a function\n  at boot" });
    // Never any user/session/content fields.
    expect(Object.keys(event).sort()).toEqual([
      "environment",
      "event_id",
      "exception",
      "extra",
      "level",
      "platform",
      "release",
      "request",
      "tags",
      "timestamp",
    ]);
  });

  test("bounds message and stack sizes and omits absent fields", () => {
    const event = buildWebErrorEvent({
      type: "Error",
      message: "m".repeat(5000),
      url: "https://app.openworklabs.com/",
      phase: "runtime",
    });
    expect(event.exception.values[0].value).toHaveLength(1000);
    expect(event.release).toBeUndefined();
    expect(event.extra).toBeUndefined();
  });
});

describe("buildSentryEnvelope", () => {
  test("produces a three-line event envelope", () => {
    const event = buildWebErrorEvent({
      type: "Error",
      message: "boom",
      url: "https://app.openworklabs.com/",
      phase: "runtime",
    });
    const lines = buildSentryEnvelope(event).split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]).event_id).toBe(event.event_id);
    expect(JSON.parse(lines[1])).toEqual({ type: "event" });
    expect(JSON.parse(lines[2]).exception.values[0].value).toBe("boom");
  });
});
