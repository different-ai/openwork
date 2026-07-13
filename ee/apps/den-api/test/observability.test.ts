import { describe, expect, test } from "bun:test"
import { Hono } from "hono"

import { parseDenApiObservabilityConfig } from "../src/observability/config.js"
import { createRequestAccessLogMiddleware, createTelemetryErrorSanitizerMiddleware } from "../src/observability/hono.js"
import { createAppLogger } from "../src/observability/logger.js"
import { getRuntimeState, parseSentryTraceHeader, sanitizeSentryEvent, sanitizeSentryLog, sanitizeSentrySpan } from "../src/observability/runtime.js"
import { sanitizeExceptionForTelemetry } from "../src/observability/safe-fields.js"
import {
  AUDIT_ALERT_OPERATIONAL_MARKER,
  SCIM_MAINTENANCE_FAILED_OPERATIONAL_MARKER,
  SCIM_SYNC_FAILURE_RECORDED_OPERATIONAL_MARKER,
} from "../src/operational-log-markers.js"

function parseLogLine(line: string) {
  return JSON.parse(line)
}

describe("den-api observability backend selection", () => {
  test("defaults to no provider and rejects unknown backends", () => {
    expect(parseDenApiObservabilityConfig({}).backend).toBe("none")
    expect(() => parseDenApiObservabilityConfig({ DEN_OBSERVABILITY_BACKEND: "stdout" })).toThrow("DEN_OBSERVABILITY_BACKEND")
  })

  test("selects otel and sentry from the shared contract", () => {
    expect(parseDenApiObservabilityConfig({
      DEN_OBSERVABILITY_BACKEND: "otel",
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example.test/otlp",
    }).backend).toBe("otel")
    expect(parseDenApiObservabilityConfig({
      DEN_OBSERVABILITY_BACKEND: "sentry",
      SENTRY_DSN: "https://public@sentry.example.test/123",
    }).backend).toBe("sentry")
  })

  test("honors OTEL_SERVICE_NAME with a den-api default", () => {
    expect(parseDenApiObservabilityConfig({}).serviceName).toBe("den-api")
    expect(parseDenApiObservabilityConfig({ OTEL_SERVICE_NAME: "custom-den-api" }).serviceName).toBe("custom-den-api")
  })
})

describe("den-api app logger", () => {
  test("writes structured JSON stdout with redaction when no provider is active", () => {
    const lines: string[] = []
    const logger = createAppLogger({
      serviceName: "den-api",
      fields: { component: "test" },
      write: (line) => lines.push(line),
    })

    logger.info("hello", {
      authorization: "Bearer secret",
      url: "https://example.test/path?token=secret",
      nested: { apiKey: "secret" },
    })

    expect(lines).toHaveLength(1)
    expect(parseLogLine(lines[0])).toMatchObject({
      component: "test",
      level: "info",
      service: "den-api",
      message: "hello",
      authorization: "[redacted]",
      url: "https://example.test/path",
      nested: { apiKey: "[redacted]" },
    })
  })

  test("adds active trace correlation when provided by the backend", () => {
    const lines: string[] = []
    const logger = createAppLogger({
      serviceName: "den-api",
      write: (line) => lines.push(line),
      getTraceContext: () => ({ trace_id: "trace-1", span_id: "span-1" }),
    })

    logger.warn("correlated")

    expect(parseLogLine(lines[0])).toMatchObject({
      trace_id: "trace-1",
      span_id: "span-1",
    })
  })

  test("sends the same sanitized correlated event to the provider sink", () => {
    const lines: string[] = []
    const providerEvents: Array<{ level: string; message: string; fields: Record<string, unknown> }> = []
    const logger = createAppLogger({
      serviceName: "den-api",
      write: (line) => lines.push(line),
      getTraceContext: () => ({ trace_id: "trace-2", span_id: "span-2" }),
      emitProviderLog: (level, message, fields) => providerEvents.push({ level, message, fields }),
    })

    logger.error("failed token=secret", { cookie: "secret", url: "https://user:pass@example.test/path?secret=1" })

    expect(parseLogLine(lines[0])).toMatchObject({
      message: "failed token=[redacted]",
      cookie: "[redacted]",
      url: "https://example.test/path",
      trace_id: "trace-2",
      span_id: "span-2",
    })
    expect(providerEvents).toEqual([
      {
        level: "error",
        message: "failed token=[redacted]",
        fields: expect.objectContaining({
          cookie: "[redacted]",
          url: "https://example.test/path",
          trace_id: "trace-2",
          span_id: "span-2",
        }),
      },
    ])
  })

  test("preserves documented operational routing markers in message and fields", () => {
    const lines: string[] = []
    const logger = createAppLogger({
      serviceName: "den-api",
      write: (line) => lines.push(line),
    })

    logger.warn(`${AUDIT_ALERT_OPERATIONAL_MARKER} organization audit alert`, {
      operational_marker: AUDIT_ALERT_OPERATIONAL_MARKER,
    })
    logger.error(`${SCIM_SYNC_FAILURE_RECORDED_OPERATIONAL_MARKER} scim sync failure recorded`, {
      operational_marker: SCIM_SYNC_FAILURE_RECORDED_OPERATIONAL_MARKER,
    })
    logger.error(`${SCIM_MAINTENANCE_FAILED_OPERATIONAL_MARKER} scim maintenance failed`, {
      operational_marker: SCIM_MAINTENANCE_FAILED_OPERATIONAL_MARKER,
    })

    expect(lines.map(parseLogLine)).toMatchObject([
      {
        message: `${AUDIT_ALERT_OPERATIONAL_MARKER} organization audit alert`,
        operational_marker: AUDIT_ALERT_OPERATIONAL_MARKER,
      },
      {
        message: `${SCIM_SYNC_FAILURE_RECORDED_OPERATIONAL_MARKER} scim sync failure recorded`,
        operational_marker: SCIM_SYNC_FAILURE_RECORDED_OPERATIONAL_MARKER,
      },
      {
        message: `${SCIM_MAINTENANCE_FAILED_OPERATIONAL_MARKER} scim maintenance failed`,
        operational_marker: SCIM_MAINTENANCE_FAILED_OPERATIONAL_MARKER,
      },
    ])
  })
})

describe("den-api Sentry sanitization", () => {
  test("sanitizes event requests, exceptions, breadcrumbs, contexts, and transactions", () => {
    const event = sanitizeSentryEvent({
      message: "failed token=secret at https://user:pass@example.test/private/user_123?token=secret",
      transaction: "GET /private/user_123",
      request: {
        url: "https://user:pass@example.test/private/user_123?token=secret",
        query_string: "token=secret",
        cookies: "session=secret",
        headers: { authorization: "Bearer secret" },
        data: { token: "secret" },
      },
      contexts: {
        den_api: { request_id: "request_test", http_route: "unmatched" },
        custom: { token: "secret", nested: { email: "person@example.test" } },
      },
      extra: { body: { token: "secret" } },
      tags: { safe: "ok", token: "secret" },
      user: { id: "user_123", email: "person@example.test" },
      breadcrumbs: [{
        message: "clicked https://user:pass@example.test/path?token=secret",
        data: { authorization: "Bearer secret", nested: { body: "secret" } },
      }],
      exception: {
        values: [{
          type: "Error",
          value: "token=secret at https://user:pass@example.test/private/user_123?token=secret",
          stacktrace: {
            frames: [{
              filename: "https://user:pass@example.test/app.js?token=secret",
              context_line: "const token = 'secret'",
              vars: { token: "secret" },
            }],
          },
        }],
      },
    })

    expect(event.request?.url).toBe("https://example.test/unmatched")
    expect(event.request?.query_string).toBeUndefined()
    expect(event.request?.cookies).toBeUndefined()
    expect(event.request?.headers).toBeUndefined()
    expect(event.request?.data).toBeUndefined()
    expect(event.transaction).toBe("GET unmatched")
    expect(event.user).toBeUndefined()
    expect(event.exception?.values?.[0]?.stacktrace?.frames?.[0]?.context_line).toBeUndefined()
    expect(event.exception?.values?.[0]?.stacktrace?.frames?.[0]?.vars).toBeUndefined()
    expect(JSON.stringify(event)).not.toContain("secret")
    expect(JSON.stringify(event)).not.toContain("user:pass")
    expect(JSON.stringify(event)).not.toContain("user_123")
    expect(JSON.stringify(event)).not.toContain("person@example.test")
  })

  test("sanitizes Sentry logs and spans before provider export", () => {
    const log = sanitizeSentryLog({
      message: "failed token=secret",
      body: { token: "secret" },
      attributes: {
        email: "person@example.test",
        url: "https://user:pass@example.test/path?token=secret",
      },
    })
    const span = sanitizeSentrySpan({
      description: "GET /private/user_123",
      data: {
        "http.route": "/*",
        url: "https://user:pass@example.test/path?token=secret",
      },
    })

    expect(log).toMatchObject({
      message: "failed token=[redacted]",
      body: "[redacted]",
      attributes: {
        email: "[redacted]",
        url: "https://example.test/path",
      },
    })
    expect(span).toMatchObject({
      description: "GET unmatched",
      data: {
        "http.route": "unmatched",
        url: "https://example.test/path",
      },
    })
    expect(JSON.stringify(log)).not.toContain("secret")
    expect(JSON.stringify(span)).not.toContain("user_123")
  })

  test("parses Sentry trace headers for stdout correlation", () => {
    expect(parseSentryTraceHeader("4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-1")).toMatchObject({
      trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
      span_id: "00f067aa0ba902b7",
      sentry_trace: "4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-1",
    })
  })
})

describe("den-api telemetry sanitization", () => {
  test("sanitizes exception payloads before provider capture", () => {
    const error = new Error("request failed token=secret at https://user:pass@example.test/path?secret=1")
    error.stack = "Error: token=secret\n    at https://user:pass@example.test/path?secret=1"

    const sanitized = sanitizeExceptionForTelemetry(error)

    expect(sanitized.message).toBe("request failed token=[redacted] at https://example.test/path")
    expect(sanitized.stack).not.toContain("secret")
    expect(sanitized.stack).not.toContain("user:pass")
  })

  test("rethrows sanitized request errors before provider middleware observes them", async () => {
    const observedErrors: unknown[] = []
    const app = new Hono()

    app.use("*", async (c, next) => {
      await next()
      observedErrors.push(c.error)
    })
    app.use("*", createTelemetryErrorSanitizerMiddleware())
    app.get("/boom", () => {
      throw new Error("request failed token=secret at https://user:pass@example.test/private/user_123?token=secret")
    })
    app.onError((_error, c) => c.text("caught", 500))

    const response = await app.request("http://den-api.test/boom")
    const observedError = observedErrors[0]

    expect(response.status).toBe(500)
    expect(observedError).toBeInstanceOf(Error)
    if (observedError instanceof Error) {
      expect(observedError.message).toBe("request failed token=[redacted] at https://example.test/private/user_123")
      expect(observedError.stack).not.toContain("secret")
      expect(observedError.stack).not.toContain("user:pass")
    }
  })
})

describe("den-api request access logs", () => {
  test("logs completion fields with normalized routes and skips query values", async () => {
    const lines: string[] = []
    const logger = createAppLogger({ serviceName: "den-api", write: (line) => lines.push(line) })
    const app = new Hono<{ Variables: { requestId: string } }>()

    app.use("*", async (c, next) => {
      c.set("requestId", "request_test")
      await next()
    })
    app.use("*", createRequestAccessLogMiddleware(logger))
    app.get("/v1/orgs/:orgId", (c) => c.json({ ok: true }))

    const response = await app.request("http://den-api.test/v1/orgs/org_123?token=secret")

    expect(response.status).toBe(200)
    expect(lines).toHaveLength(1)
    expect(parseLogLine(lines[0])).toMatchObject({
      request_id: "request_test",
      http_method: "GET",
      http_route: "/v1/orgs/:orgId",
      http_status_code: 200,
    })
    expect(lines[0]).not.toContain("secret")
  })

  test("does not emit noisy health access logs", async () => {
    const lines: string[] = []
    const logger = createAppLogger({ serviceName: "den-api", write: (line) => lines.push(line) })
    const app = new Hono<{ Variables: { requestId: string } }>()

    app.use("*", async (c, next) => {
      c.set("requestId", "request_test")
      await next()
    })
    app.use("*", createRequestAccessLogMiddleware(logger))
    app.get("/health", (c) => c.json({ ok: true }))

    const response = await app.request("http://den-api.test/health")

    expect(response.status).toBe(200)
    expect(lines).toHaveLength(0)
  })

  test("uses a non-raw route label for unmatched requests", async () => {
    const lines: string[] = []
    const logger = createAppLogger({ serviceName: "den-api", write: (line) => lines.push(line) })
    const app = new Hono<{ Variables: { requestId: string } }>()

    app.use("*", async (c, next) => {
      c.set("requestId", "request_test")
      await next()
    })
    app.use("*", createRequestAccessLogMiddleware(logger))

    const response = await app.request("http://den-api.test/private/user_123?token=secret")

    expect(response.status).toBe(404)
    expect(parseLogLine(lines[0])).toMatchObject({
      http_route: "unmatched",
      http_status_code: 404,
    })
    expect(lines[0]).not.toContain("user_123")
    expect(lines[0]).not.toContain("secret")
  })

  test("attaches request context to the active provider hook", async () => {
    const state = getRuntimeState()
    const previousAttachRequestContext = state.attachRequestContext
    const attachedFields: Array<Record<string, unknown>> = []
    const lines: string[] = []
    const logger = createAppLogger({ serviceName: "den-api", write: (line) => lines.push(line) })
    const app = new Hono<{ Variables: { requestId: string } }>()

    state.attachRequestContext = (fields) => {
      attachedFields.push(fields)
    }
    try {
      app.use("*", async (c, next) => {
        c.set("requestId", "request_test")
        await next()
      })
      app.use("*", createRequestAccessLogMiddleware(logger))
      app.get("/v1/orgs/:orgId", (c) => c.json({ ok: true }))

      const response = await app.request("http://den-api.test/v1/orgs/org_123")

      expect(response.status).toBe(200)
      expect(attachedFields).toContainEqual(expect.objectContaining({ request_id: "request_test" }))
      expect(attachedFields).toContainEqual(expect.objectContaining({
        request_id: "request_test",
        http_route: "/v1/orgs/:orgId",
        http_status_code: 200,
      }))
    } finally {
      state.attachRequestContext = previousAttachRequestContext
    }
  })
})
