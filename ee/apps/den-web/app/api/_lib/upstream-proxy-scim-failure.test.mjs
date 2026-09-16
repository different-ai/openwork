import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";

import { proxyUpstream } from "./upstream-proxy.ts";
import {
  denWebLogger, reportScimProxyFailure, resetDenWebObservabilityStateForTests, setStructuredLogSink,
} from "../../../observability/runtime-logger.ts";
import { initSentryRuntime } from "../../../observability/sentry-runtime.ts";
import {
  canonicalScimProxyPath, classifyScimProxyFailure, scimProxyFailureDiagnostic,
  scimProxyFailureEvent, scimProxyFailureFields, scrubScimProxyFailureEvent,
} from "../../../observability/scim-proxy-failure.ts";

const options = { routePrefix: "/api/auth", upstreamPathPrefix: "api/auth" };
const sentryEnv = {
  DEN_OBSERVABILITY_BACKEND: "sentry",
  SENTRY_DSN: "https://public@sentry.example.test/123",
  SENTRY_TRACES_SAMPLE_RATE: "0",
};
const privateText = "private-fixture@example.test";
const originalFetch = globalThis.fetch;
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalNow = Date.now;
const originalApiBase = process.env.DEN_API_BASE;
let stdout;
let logs;

beforeEach(() => {
  resetDenWebObservabilityStateForTests();
  process.env.DEN_API_BASE = "https://api.example.test";
  stdout = [];
  logs = [];
  console.log = (line) => stdout.push(line);
  console.error = (line) => stdout.push(line);
  setStructuredLogSink({ log: (...entry) => logs.push(entry) });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.log = originalConsoleLog;
  console.error = originalConsoleError;
  Date.now = originalNow;
  resetDenWebObservabilityStateForTests();
  if (originalApiBase === undefined) delete process.env.DEN_API_BASE;
  else process.env.DEN_API_BASE = originalApiBase;
});

function fixtureFields(overrides = {}) {
  return scimProxyFailureFields({
    error: new TypeError(privateText, { cause: { code: "UND_ERR_NOT_SUPPORTED", message: privateText } }),
    abortCause: null,
    method: "POST",
    path: "/api/auth/scim/v2/Users",
    referenceId: privateText,
    durationMs: 12,
    observedBytes: 19,
    expect: "100-continue",
    ...overrides,
  });
}

function fakeSentry() {
  const events = [];
  const sentryLogs = [];
  let initOptions;
  const sdk = {
    init: (value) => { initOptions = value; },
    setAttributes() {},
    captureEvent: (event) => { events.push(event); },
    logger: {
      debug: (...args) => sentryLogs.push(args),
      info: (...args) => sentryLogs.push(args),
      warn: (...args) => sentryLogs.push(args),
      error: (...args) => sentryLogs.push(args),
    },
  };
  return { sdk, events, sentryLogs, get options() { return initOptions; } };
}

describe("SCIM proxy safe classification", () => {
  test.each([
    ["UND_ERR_NOT_SUPPORTED", "unsupported_request"], ["UND_ERR_INVALID_ARG", "invalid_request"],
    ["UND_ERR_REQ_CONTENT_LENGTH_MISMATCH", "invalid_request"],
    ["UND_ERR_CONNECT_TIMEOUT", "timeout"], ["UND_ERR_HEADERS_TIMEOUT", "timeout"],
    ["UND_ERR_BODY_TIMEOUT", "timeout"], ["ETIMEDOUT", "timeout"],
    ["ECONNREFUSED", "connection"], ["ECONNRESET", "connection"], ["EPIPE", "connection"],
    ["UND_ERR_SOCKET", "connection"], ["ENOTFOUND", "dns"], ["EAI_AGAIN", "dns"],
    ["CERT_HAS_EXPIRED", "tls"], ["DEPTH_ZERO_SELF_SIGNED_CERT", "tls"],
    ["SELF_SIGNED_CERT_IN_CHAIN", "tls"], ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "tls"],
    ["ERR_TLS_CERT_ALTNAME_INVALID", "tls"], ["UND_ERR_ABORTED", "aborted"],
  ])("allowlists %s as %s without exporting the exception", (code, category) => {
    const error = new TypeError(privateText, { cause: new Error(privateText, { cause: { code } }) });
    const fields = classifyScimProxyFailure(error, null);
    expect(fields).toEqual({ error_name: "TypeError", cause_code: code, failure_class: category });
    expect(JSON.stringify(fields)).not.toContain(privateText);
  });

  test("classifies exact known fetch messages without exporting arbitrary message text", () => {
    const unsupported = new TypeError("fetch failed", {
      cause: { code: "UND_ERR_NOT_SUPPORTED", message: "expect header not supported" },
    });
    expect(classifyScimProxyFailure(unsupported, null)).toEqual({
      error_name: "TypeError", cause_code: "UND_ERR_NOT_SUPPORTED", failure_class: "expect_header_unsupported",
    });
    const detached = new TypeError("Cannot perform ArrayBuffer.prototype.slice on a detached ArrayBuffer");
    expect(classifyScimProxyFailure(detached, null).failure_class).toBe("detached_body_buffer");
    expect(classifyScimProxyFailure(unsupported, "deadline").failure_class).toBe("deadline");
    const arbitrary = classifyScimProxyFailure(new TypeError(`expect header not supported ${privateText}`), null);
    expect(arbitrary.failure_class).toBe("type_error");
    expect(JSON.stringify(arbitrary)).not.toContain(privateText);
  });

  test("bounds cause traversal and never invokes getters or exports unknown names/codes", () => {
    const hostile = Object.defineProperties({}, {
      code: { get() { throw new Error(privateText); } },
      message: { get() { throw new Error(privateText); } },
      stack: { get() { throw new Error(privateText); } },
    });
    hostile.cause = hostile;
    for (const error of [hostile, { name: privateText, code: privateText }, privateText,
      new Proxy({}, { getOwnPropertyDescriptor() { throw new Error(privateText); } })]) {
      expect(classifyScimProxyFailure(error, null)).toEqual({
        error_name: "unknown", cause_code: "unknown", failure_class: "unknown",
      });
    }
    const tooDeep = { cause: { cause: { cause: { cause: { code: "ECONNREFUSED" } } } } };
    expect(classifyScimProxyFailure(tooDeep, null).cause_code).toBe("unknown");
    expect(classifyScimProxyFailure(new Error(privateText), "client").failure_class).toBe("client_abort");
    expect(classifyScimProxyFailure(new Error(privateText), "deadline").failure_class).toBe("deadline");
  });

  test("only recognizes the canonical proxy and emits finite path templates", () => {
    expect(canonicalScimProxyPath("/api/auth", "api/auth", `scim/v2/Users/${privateText}`)).toBe("/api/auth/scim/v2/Users/:id");
    expect(canonicalScimProxyPath("/api/auth", "api/auth", `scim/v2/${privateText}`)).toBe("/api/auth/scim/v2/:path");
    expect(canonicalScimProxyPath("/api/auth", "api/auth", `scim/v2/Users/${"x".repeat(3000)}`)).toBe("/api/auth/scim/v2/:path");
    for (const path of ["scim/v20/Users", "scim/generate-token", "callback/scim", "v1/scim"]) {
      expect(canonicalScimProxyPath("/api/auth", "api/auth", path)).toBeNull();
    }
    expect(canonicalScimProxyPath("/api/den", "", "api/auth/scim/v2/Users")).toBeNull();
    expect(canonicalScimProxyPath("/api/auth", "v1/scim", "scim/v2/Users")).toBeNull();
  });

  test.each([
    [null, false, false], ["", true, false], [privateText, true, false],
    ["100-continue", true, true], [" 100-ConTinue ", true, true],
  ])("records only booleans for Expect %s", async (value, present, continue100) => {
    const fields = await fixtureFields({ expect: value });
    expect(fields.has_expect).toBe(present);
    expect(fields.expect_100_continue).toBe(continue100);
    expect(fields.request_id).toBe(`sha256:${createHash("sha256").update(privateText).digest("hex")}`);
    expect(fields.observed_bytes).toBe(19);
    expect(JSON.stringify(fields)).not.toContain(privateText);
  });
});

describe("SCIM failure response and non-SCIM isolation", () => {
  test.each([201, 409])("POST with mixed-case Expect preserves body and upstream %s", async (status) => {
    const body = JSON.stringify({ userName: "synthetic@example.test", displayName: "Synthetic – test" });
    const upstreamBody = JSON.stringify(status === 201
      ? { id: "synthetic-user", userName: "synthetic@example.test" }
      : { schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"], status: "409", scimType: "uniqueness", detail: "Conflict" });
    let calls = 0;
    globalThis.fetch = async (url, init) => {
      calls += 1;
      // Model Node's rejection so this regression fails with the old forwarding.
      if (init.headers.has("expect")) {
        throw new TypeError("fetch failed", { cause: { code: "UND_ERR_NOT_SUPPORTED", message: "expect header not supported" } });
      }
      expect(url).toBe("https://api.example.test/api/auth/scim/v2/Users");
      expect(init.method).toBe("POST");
      expect(init.headers.get("content-type")).toBe("application/scim+json");
      expect(init.headers.get("authorization")).toBe("Bearer synthetic-token");
      expect(init.headers.has("content-length")).toBe(false);
      expect(new Uint8Array(await init.body.arrayBuffer())).toEqual(new TextEncoder().encode(body));
      return new Response(upstreamBody, { status, headers: { "content-type": "application/scim+json" } });
    };
    const request = new NextRequest("https://app.example.test/api/auth/scim/v2/Users", {
      method: "POST", body, headers: {
        ExPeCt: "100-continue", authorization: "Bearer synthetic-token",
        "content-type": "application/scim+json", "content-length": String(new TextEncoder().encode(body).byteLength),
      },
    });
    const response = await proxyUpstream(request, [], options);
    expect(calls).toBe(1);
    expect(request.headers.get("expect")).toBe("100-continue");
    expect(response.status).toBe(status);
    expect(response.headers.get("content-type")).toBe("application/scim+json");
    expect(await response.text()).toBe(upstreamBody);
    expect(logs.some((entry) => entry[0] === "error")).toBe(false);
  });

  test("strips Expect while preserving bytes, queries, authorization and unrelated fetch failures", async () => {
    const body = JSON.stringify({ userName: privateText });
    let forwarded;
    globalThis.fetch = async (url, init) => {
      forwarded = { url, init, body: await init.body.text() };
      throw new TypeError(privateText, { cause: { code: "UND_ERR_NOT_SUPPORTED" } });
    };
    const response = await proxyUpstream(new NextRequest(
      `https://app.example.test/api/auth/scim/v2/Users/${privateText}?filter=${privateText}`,
      { method: "PATCH", body, headers: {
        expect: "100-continue", authorization: "Bearer private-fixture", "x-request-id": privateText,
        cookie: "better-auth.session_token=private-fixture", "content-type": "application/scim+json",
      } },
    ), [], options);
    expect(forwarded.init.headers.get("expect")).toBeNull();
    expect(forwarded.init.headers.get("authorization")).toBe("Bearer private-fixture");
    expect(forwarded.init.headers.get("cookie")).toBe("better-auth.session_token=private-fixture");
    expect(forwarded.init.redirect).toBe("manual");
    expect(forwarded.body).toBe(body);
    expect(forwarded.url).toContain(`?filter=${privateText}`);
    expect(response.status).toBe(502);
    expect(response.headers.get("x-request-id")).toBe(privateText);
    expect(await response.json()).toEqual({
      error: "upstream_unreachable", message: "The upstream service could not be reached.", referenceId: privateText,
    });
    expect(logs).toHaveLength(1);
    expect(logs[0][2]).toMatchObject({
      error_name: "TypeError", failure_class: "unsupported_request", cause_code: "UND_ERR_NOT_SUPPORTED",
      upstream_path: "/api/auth/scim/v2/Users/:id", has_expect: false, expect_100_continue: false,
      method: "PATCH", observed_bytes: new TextEncoder().encode(body).byteLength,
    });
    expect(logs[0][2].duration_ms).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(logs)).not.toContain("private-fixture");
  });

  test("retains the 504 response and rethrows the exact client abort even if reporting throws", async () => {
    const abortError = new Error(privateText);
    globalThis.fetch = async (_url, init) => await new Promise((_resolve, reject) => {
      if (init.signal.aborted) reject(abortError);
      else init.signal.addEventListener("abort", () => reject(abortError), { once: true });
    });
    setStructuredLogSink({ log() { throw new Error(privateText); }, captureScimProxyFailure() { throw new Error(privateText); } });
    const response = await proxyUpstream(new NextRequest("https://app.example.test/api/auth/scim/v2/Users", {
      headers: { "x-request-id": "fixture-timeout" },
    }), [], { ...options, upstreamDeadlineMs: 1 });
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({
      error: "upstream_timeout", message: "The upstream service did not respond before the deadline.", referenceId: "fixture-timeout",
    });
    expect(JSON.parse(stdout[0]).failure_class).toBe("deadline");
    const client = new AbortController();
    client.abort(abortError);
    await expect(proxyUpstream(new NextRequest("https://app.example.test/api/auth/scim/v2/Users", {
      signal: client.signal,
    }), [], options)).rejects.toBe(abortError);
    expect(JSON.parse(stdout[1]).failure_class).toBe("client_abort");
  });

  test("a failed SCIM fetch still returns 502 when stdout fails, and attempts the independent error report", async () => {
    const sentry = fakeSentry();
    initSentryRuntime(sentry.sdk, sentryEnv);
    console.log = () => { throw new Error(privateText); };
    globalThis.fetch = async () => { throw new TypeError(privateText); };
    const response = await proxyUpstream(new NextRequest("https://app.example.test/api/auth/scim/v2/Groups"), [], options);
    expect(response.status).toBe(502);
    expect(sentry.events).toHaveLength(1);
    expect(sentry.events[0].extra.upstream_path).toBe("/api/auth/scim/v2/Groups");
    expect(JSON.stringify(sentry.events)).not.toContain(privateText);
    setStructuredLogSink({ log() { throw new Error(privateText); } });
    const withoutSentry = await proxyUpstream(new NextRequest("https://app.example.test/api/auth/scim/v2/Groups"), [], options);
    expect(withoutSentry.status).toBe(502);
  });

  test("does not change non-SCIM logging or report HTTP errors/successes as fetch failures", async () => {
    const sentry = fakeSentry();
    initSentryRuntime(sentry.sdk, sentryEnv);
    globalThis.fetch = async () => { throw new TypeError(privateText); };
    const response = await proxyUpstream(new NextRequest("https://app.example.test/api/auth/session"), [], options);
    expect(response.status).toBe(502);
    expect(sentry.sentryLogs[0][0]).toBe("den-web upstream proxy failed");
    expect(sentry.sentryLogs[0][1].error_name).toBe("TypeError");
    expect(sentry.sentryLogs[0][1].failure_class).toBeUndefined();
    expect(sentry.events).toHaveLength(0);
    expect(stdout).toHaveLength(0);
    for (const status of [200, 400, 500]) {
      globalThis.fetch = async () => new Response("fixture response", { status });
      const response = await proxyUpstream(new NextRequest("https://app.example.test/api/auth/scim/v2/Users"), [], options);
      expect(response.status).toBe(status);
      expect(await response.text()).toBe("fixture response");
    }
    expect(sentry.events).toHaveLength(0);
    expect(stdout).toHaveLength(0);
    const tooLarge = await proxyUpstream(new NextRequest("https://app.example.test/api/auth/scim/v2/Users", {
      method: "POST", body: "fixture", headers: { "content-length": "7" },
    }), [], { ...options, maxRequestBodyBytes: 1 });
    expect(tooLarge.status).toBe(413);
    expect(sentry.events).toHaveLength(0);
  });
});

describe("SCIM observability backend and Sentry boundary", () => {
  test.each(["none", "otel"])("does not initialize/capture Sentry for backend %s", async (backend) => {
    const sentry = fakeSentry();
    initSentryRuntime(sentry.sdk, {
      DEN_OBSERVABILITY_BACKEND: backend,
      OTEL_TRACES_EXPORTER: "none",
      OTEL_METRICS_EXPORTER: "none",
      OTEL_LOGS_EXPORTER: "none",
    });
    reportScimProxyFailure(await fixtureFields());
    expect(sentry.options).toBeUndefined();
    expect(sentry.events).toHaveLength(0);
    expect(logs).toHaveLength(1);
  });

  test("reports independently of trace sampling with a bounded rate limit and all stdout diagnostics", async () => {
    const sentry = fakeSentry();
    initSentryRuntime(sentry.sdk, sentryEnv);
    expect(sentry.options.tracesSampleRate).toBe(0);
    const fields = await fixtureFields();
    let now = 1_000;
    Date.now = () => now;
    for (let index = 0; index < 20; index += 1) reportScimProxyFailure(fields);
    expect(sentry.events).toHaveLength(5);
    expect(stdout).toHaveLength(20);
    expect(sentry.sentryLogs).toHaveLength(0);
    expect(JSON.parse(stdout[0])).toMatchObject(fields);
    now += 60_000;
    reportScimProxyFailure(fields);
    expect(sentry.events).toHaveLength(6);
    denWebLogger.info("ordinary fixture log", { status: 200 });
    expect(sentry.sentryLogs).toHaveLength(1);
    expect(stdout).toHaveLength(21);
  });

  test("rebuilds the error event rather than retaining request/scope data and rejects poisoned fields", async () => {
    const fields = await fixtureFields();
    const hint = { attachments: [{ filename: privateText, data: privateText }] };
    const event = scrubScimProxyFailureEvent({
      ...scimProxyFailureEvent(fields),
      extra: { ...fields, unexpected: privateText },
      request: { url: `https://app.example.test/${privateText}?filter=${privateText}`, headers: { authorization: privateText }, data: privateText },
      user: { email: privateText }, breadcrumbs: [{ message: privateText }],
      contexts: { extra: { email: privateText } }, tags: { diagnostic: scimProxyFailureDiagnostic, email: privateText },
      sdkProcessingMetadata: { dynamicSamplingContext: { transaction: privateText } },
      exception: { values: [{ value: privateText, stacktrace: { frames: [{ filename: privateText }] } }] },
    }, hint);
    expect(hint.attachments).toEqual([]);
    expect(event.extra).toEqual(fields);
    expect(JSON.stringify(event)).not.toContain(privateText);
    expect(event.request).toBeUndefined();
    expect(event.breadcrumbs).toBeUndefined();
    expect(event.sdkProcessingMetadata).toBeUndefined();
    expect(scrubScimProxyFailureEvent({ ...event, extra: { ...fields, cause_code: privateText } }, {})).toBeNull();
  });

  test("Sentry 10.64 transport receives no ambient request, URL, body, breadcrumbs, attachments or DSC", async () => {
    expect(Sentry.SDK_VERSION).toBe("10.64.0");
    const sentry = fakeSentry();
    initSentryRuntime(sentry.sdk, sentryEnv);
    const envelopes = [];
    let beforeScrub;
    const client = new Sentry.NodeClient({
      ...sentry.options,
      // Use the installed request enrichment and event pipeline without network or global instrumentation.
      integrations: [Sentry.requestDataIntegration()],
      stackParser: Sentry.defaultStackParser,
      beforeSend: (event, hint) => {
        beforeScrub = event;
        return sentry.options.beforeSend(event, hint);
      },
      transport: () => ({
        send: async (envelope) => { envelopes.push(envelope); return { statusCode: 200 }; },
        flush: async () => true,
      }),
    });
    client.init();
    const scope = new Sentry.Scope();
    scope.setUser({ email: privateText });
    scope.setTag("untrusted", privateText);
    scope.setExtra("untrusted", privateText);
    scope.addBreadcrumb({ message: privateText });
    scope.addAttachment({ filename: "fixture.txt", data: privateText });
    scope.setSDKProcessingMetadata({ normalizedRequest: {
      url: `https://app.example.test/api/auth/scim/v2/Users/${privateText}`,
      headers: { authorization: privateText, cookie: privateText }, data: privateText,
      query_string: `filter=${privateText}`, method: "POST",
    }, dynamicSamplingContext: { transaction: privateText } });
    try {
      await Sentry.withIsolationScope(async (isolation) => {
        isolation.setUser({ email: privateText });
        isolation.addBreadcrumb({ message: privateText });
        isolation.addAttachment({ filename: "isolation-fixture.txt", data: privateText });
        client.captureEvent(scimProxyFailureEvent(await fixtureFields()), {}, scope);
        await client.flush(1_000);
      });
      expect(beforeScrub.request.data).toBe(privateText);
      expect(beforeScrub.request.url).toContain(privateText);
      expect(beforeScrub.breadcrumbs.length).toBeGreaterThan(0);
      expect(envelopes).toHaveLength(1);
      expect(envelopes[0][1]).toHaveLength(1);
      expect(envelopes[0][0].trace).toBeUndefined();
      const event = envelopes[0][1][0][1];
      expect(event.exception.values[0].type).toBe("ScimProxyFetchFailure");
      expect(event.extra.cause_code).toBe("UND_ERR_NOT_SUPPORTED");
      expect(event.request).toBeUndefined();
      expect(event.user).toBeUndefined();
      expect(event.contexts).toBeUndefined();
      expect(event.breadcrumbs).toBeUndefined();
      expect(JSON.stringify(envelopes)).not.toContain(privateText);
    } finally {
      await client.close(1_000);
    }
  });
});
