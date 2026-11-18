import { describe, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import {
  buildSentryEnvelope,
  buildWebErrorEvent,
  parseSentryDsn,
  sanitizePageUrl,
  shouldMonitorWebErrors,
  startWebErrorMonitoring,
  type WebErrorEvent,
} from "../src/app/lib/error-monitoring";
import { AppErrorBoundary } from "../src/react-app/shell/app-error-boundary";

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

describe("reportCaughtWebError", () => {
  // Bun aliases import.meta.env to process.env, so the build-time gate can be
  // driven at runtime. Module state only opens once, so desktop runs first.
  // The boundary's componentDidCatch is the real caller, so the hand-off and
  // its redaction are exercised through it.
  test("boundary-caught errors redact quoted identity, message and stack in web envelopes, dedupe, and stay inert on desktop", async () => {
    GlobalRegistrator.register({ url: "https://app.openworklabs.com/signin?grant=secret-grant" });
    const actEnvironment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const bodies: string[] = [];
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      bodies.push(String(init?.body));
      return Promise.resolve(new Response());
    });
    const logError = spyOn(console, "error").mockImplementation(() => {});
    const previous = {
      deployment: process.env.VITE_OPENWORK_DEPLOYMENT,
      dsn: process.env.VITE_OPENWORK_SENTRY_DSN,
    };
    const boundary = new AppErrorBoundary({ children: null });
    const info = { componentStack: "\n    at AppRoot" };
    const thrown = new Error("Deep link rejected: openwork://open?token=eval-secret-token");
    try {
      process.env.VITE_OPENWORK_DEPLOYMENT = "desktop";
      process.env.VITE_OPENWORK_SENTRY_DSN = DSN;
      startWebErrorMonitoring();
      boundary.componentDidCatch(thrown, info);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(window.__openworkWebErrorMonitorActive).toBeUndefined();

      process.env.VITE_OPENWORK_DEPLOYMENT = "web";
      startWebErrorMonitoring();
      boundary.componentDidCatch(thrown, info);
      boundary.componentDidCatch(thrown, info);
      expect(bodies).toHaveLength(1);
      const event = JSON.parse(bodies[0].split("\n")[2]);
      expect(event.exception.values).toEqual([{ type: "Error", value: "Deep link rejected: openwork://open" }]);
      expect(event.tags).toEqual({ boot_phase: "runtime" });
      expect(event.request).toEqual({ url: "https://app.openworklabs.com/signin" });
      expect(event.extra.stack).toContain("Deep link rejected: openwork://open");
      // Neither the page URL's grant nor the thrown URL's token leaves the page.
      expect(bodies[0]).not.toContain("secret-grant");
      expect(bodies[0]).not.toContain("eval-secret-token");

      const fields = ["token", "grant", "code", "secret", "key"];
      const opaque = ["r4Lb8xM2", "z7Qn3cV9", "p2Hs6wJ5", "f9Tk4aD7", "y3Bg8uN6"];
      for (const [index, field] of fields.entries()) {
        const canaries: string[] = [];
        function assignments(part: string, selected: string[]) {
          return selected.map((key, position) => {
            const values = [0, 1, 2, 3].map((variant) => `${part}${index}${opaque[position]}${variant}`);
            canaries.push(...values);
            return `${key}="${values[0]}" ${key}='${values[1]}' "${key}":"${values[2]}" '${key}':'${values[3]}'`;
          }).join(" ");
        }
        const error = new Error(`Recovery ${index} failed: ${assignments("m", fields)} status=502`);
        error.name = `E ${assignments("n", [field])} end`;
        error.stack = `Error: recovery trace ${assignments("s", fields)}\n    at restoreSession (session-route.tsx:42:7)`;
        function Throws(): ReactNode {
          throw error;
        }
        for (const attempt of [0, 1]) {
          await act(async () => {
            root.render(createElement(AppErrorBoundary, { key: `${index}-${attempt}` }, createElement(Throws)));
          });
          expect(container.textContent).toContain("OpenWork hit an unexpected error");
          expect(bodies).toHaveLength(index + 2);
        }
        const body = bodies[index + 1];
        const lines = body.split("\n");
        expect(lines).toHaveLength(3);
        const reported: WebErrorEvent = JSON.parse(lines[2]);
        const identity = reported.exception.values[0].type;
        const message = reported.exception.values[0].value;
        const stack = reported.extra?.stack;
        expect(identity).toStartWith("E ");
        expect(identity).toEndWith(" end");
        expect(message).toContain(`Recovery ${index} failed:`);
        expect(message).toContain("status=502");
        expect(stack).toContain("Error: recovery trace");
        expect(stack).toContain("at restoreSession (session-route.tsx:42:7)");
        expect(reported.tags).toEqual({ boot_phase: "runtime" });
        expect(reported.request).toEqual({ url: "https://app.openworklabs.com/signin" });
        for (const canary of canaries) {
          expect(body).not.toContain(canary);
          expect(identity).not.toContain(canary);
          expect(message).not.toContain(canary);
          expect(stack).not.toContain(canary);
        }
        expect(body).not.toContain("secret-grant");
        expect(identity.match(/\[redacted\]/g)).toHaveLength(4);
        expect(message.match(/\[redacted\]/g)).toHaveLength(20);
        expect(stack?.match(/\[redacted\]/g)).toHaveLength(20);
      }
      expect(fetchSpy).toHaveBeenCalledTimes(6);
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
      Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironment);
      fetchSpy.mockRestore();
      logError.mockRestore();
      if (previous.deployment === undefined) delete process.env.VITE_OPENWORK_DEPLOYMENT;
      else process.env.VITE_OPENWORK_DEPLOYMENT = previous.deployment;
      if (previous.dsn === undefined) delete process.env.VITE_OPENWORK_SENTRY_DSN;
      else process.env.VITE_OPENWORK_SENTRY_DSN = previous.dsn;
      await GlobalRegistrator.unregister();
    }
  });
});
