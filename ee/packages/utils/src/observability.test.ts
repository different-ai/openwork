import { describe, expect, test } from "bun:test"

import {
  createJsonStdoutLogger,
  parseObservabilityEnv,
} from "./observability"

describe("observability env contract", () => {
  test("defaults to disabled observability with an explicit service name", () => {
    expect(parseObservabilityEnv({}, { serviceName: "den-api" })).toEqual({
      backend: "none",
      serviceName: "den-api",
      sentryBuild: { values: {}, redactedKeys: [] },
    })
  })

  test("parses OTEL HTTP/protobuf defaults with generic and per-signal endpoints", () => {
    const config = parseObservabilityEnv(
      {
        DEN_OBSERVABILITY_BACKEND: "otel",
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example.test/otlp",
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "https://metrics.example.test/v1/metrics",
      },
      { serviceName: "den-web" },
    )

    expect(config.backend).toBe("otel")
    if (config.backend !== "otel") {
      throw new Error("expected otel backend")
    }

    expect(config.otel.protocol).toBe("http/protobuf")
    expect(config.otel.sampler).toEqual({ name: "parentbased_always_on", ratio: 1 })
    expect(config.otel.signals.traces).toEqual({
      exporter: "otlp",
      protocol: "http/protobuf",
      endpoint: "https://collector.example.test/otlp/v1/traces",
      endpointSource: "base",
    })
    expect(config.otel.signals.metrics).toEqual({
      exporter: "otlp",
      protocol: "http/protobuf",
      endpoint: "https://metrics.example.test/v1/metrics",
      endpointSource: "signal",
    })
    expect(config.otel.signals.logs).toEqual({
      exporter: "otlp",
      protocol: "http/protobuf",
      endpoint: "https://collector.example.test/otlp/v1/logs",
      endpointSource: "base",
    })
  })

  test("allows disabling individual OTEL signal exporters and configuring ratio sampling", () => {
    const config = parseObservabilityEnv(
      {
        DEN_OBSERVABILITY_BACKEND: "otel",
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example.test",
        OTEL_METRICS_EXPORTER: "none",
        OTEL_TRACES_SAMPLER: "parentbased_traceidratio",
        OTEL_TRACES_SAMPLER_ARG: "0.25",
      },
      { serviceName: "den-worker-proxy" },
    )

    expect(config.backend).toBe("otel")
    if (config.backend !== "otel") {
      throw new Error("expected otel backend")
    }

    expect(config.otel.signals.metrics.exporter).toBe("none")
    expect(config.otel.sampler).toEqual({
      name: "parentbased_traceidratio",
      ratio: 0.25,
      argument: "0.25",
    })
  })

  test("requires explicit endpoints for OTEL signals that export OTLP", () => {
    expect(() => parseObservabilityEnv(
      { DEN_OBSERVABILITY_BACKEND: "otel" },
      { serviceName: "den-api" },
    )).toThrow("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT")

    const config = parseObservabilityEnv(
      {
        DEN_OBSERVABILITY_BACKEND: "otel",
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://collector.example.test/v1/traces",
        OTEL_METRICS_EXPORTER: "none",
        OTEL_LOGS_EXPORTER: "none",
      },
      { serviceName: "den-api" },
    )

    expect(config.backend).toBe("otel")
    if (config.backend !== "otel") {
      throw new Error("expected otel backend")
    }

    expect(config.otel.signals.traces.endpoint).toBe("https://collector.example.test/v1/traces")
    expect(config.otel.signals.metrics).toEqual({
      exporter: "none",
      protocol: "http/protobuf",
      endpoint: undefined,
      endpointSource: "default",
    })
    expect(config.otel.signals.logs).toEqual({
      exporter: "none",
      protocol: "http/protobuf",
      endpoint: undefined,
      endpointSource: "default",
    })
  })

  test("preserves inactive malformed Sentry build URLs without crashing none or otel runtimes", () => {
    expect(parseObservabilityEnv(
      { SENTRY_URL: "not a url" },
      { serviceName: "den-api" },
    )).toEqual({
      backend: "none",
      serviceName: "den-api",
      sentryBuild: {
        values: { SENTRY_URL: "not a url" },
        redactedKeys: [],
      },
    })

    const config = parseObservabilityEnv(
      {
        DEN_OBSERVABILITY_BACKEND: "otel",
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example.test",
        SENTRY_URL: "not a url",
      },
      { serviceName: "den-web" },
    )

    expect(config.backend).toBe("otel")
    if (config.backend !== "otel") {
      throw new Error("expected otel backend")
    }
    expect(config.sentryBuild.values.SENTRY_URL).toBe("not a url")
  })

  test("rejects invalid OTEL backend values, exporters, protocols, samplers, and endpoint URLs", () => {
    expect(() => parseObservabilityEnv(
      { DEN_OBSERVABILITY_BACKEND: "debug" },
      { serviceName: "den-api" },
    )).toThrow("DEN_OBSERVABILITY_BACKEND")

    expect(() => parseObservabilityEnv(
      { DEN_OBSERVABILITY_BACKEND: "otel", OTEL_TRACES_EXPORTER: "console" },
      { serviceName: "den-api" },
    )).toThrow("OTEL_TRACES_EXPORTER")

    expect(() => parseObservabilityEnv(
      { DEN_OBSERVABILITY_BACKEND: "otel", OTEL_EXPORTER_OTLP_PROTOCOL: "grpc" },
      { serviceName: "den-api" },
    )).toThrow("OTEL_EXPORTER_OTLP_PROTOCOL")

    expect(() => parseObservabilityEnv(
      { DEN_OBSERVABILITY_BACKEND: "otel", OTEL_TRACES_SAMPLER: "custom" },
      { serviceName: "den-api" },
    )).toThrow("OTEL_TRACES_SAMPLER")

    expect(() => parseObservabilityEnv(
      { DEN_OBSERVABILITY_BACKEND: "otel", OTEL_EXPORTER_OTLP_ENDPOINT: "grpc://collector" },
      { serviceName: "den-api" },
    )).toThrow("OTEL_EXPORTER_OTLP_ENDPOINT")
  })

  test("parses Sentry runtime config and sanitizes build-only variables", () => {
    const config = parseObservabilityEnv(
      {
        DEN_OBSERVABILITY_BACKEND: "sentry",
        SENTRY_DSN: "https://public@sentry.example.test/123",
        SENTRY_TRACES_SAMPLE_RATE: "0.75",
        SENTRY_ORG: "openwork",
        SENTRY_PROJECT: "den-api",
        SENTRY_URL: "https://sentry.example.test",
        SENTRY_RELEASE: "2026.07.11",
        SENTRY_AUTH_TOKEN: "do-not-return",
      },
      { serviceName: "den-api" },
    )

    expect(config.backend).toBe("sentry")
    if (config.backend !== "sentry") {
      throw new Error("expected sentry backend")
    }

    expect(config.sentry).toEqual({
      dsn: "https://public@sentry.example.test/123",
      tracesSampleRate: 0.75,
    })
    expect(config.sentryBuild).toEqual({
      values: {
        SENTRY_ORG: "openwork",
        SENTRY_PROJECT: "den-api",
        SENTRY_URL: "https://sentry.example.test",
        SENTRY_RELEASE: "2026.07.11",
      },
      redactedKeys: ["SENTRY_AUTH_TOKEN"],
    })
  })

  test("defaults Sentry sample rate and rejects invalid DSNs and rates", () => {
    const config = parseObservabilityEnv(
      {
        DEN_OBSERVABILITY_BACKEND: "sentry",
        SENTRY_DSN: "https://public@sentry.example.test/123",
      },
      { serviceName: "den-web" },
    )

    expect(config.backend).toBe("sentry")
    if (config.backend !== "sentry") {
      throw new Error("expected sentry backend")
    }
    expect(config.sentry.tracesSampleRate).toBe(1)

    expect(() => parseObservabilityEnv(
      { DEN_OBSERVABILITY_BACKEND: "sentry" },
      { serviceName: "den-api" },
    )).toThrow("SENTRY_DSN")

    expect(() => parseObservabilityEnv(
      { DEN_OBSERVABILITY_BACKEND: "sentry", SENTRY_DSN: "not-a-url" },
      { serviceName: "den-api" },
    )).toThrow("SENTRY_DSN")

    expect(() => parseObservabilityEnv(
      {
        DEN_OBSERVABILITY_BACKEND: "sentry",
        SENTRY_DSN: "https://public@sentry.example.test/123",
        SENTRY_TRACES_SAMPLE_RATE: "2",
      },
      { serviceName: "den-api" },
    )).toThrow("SENTRY_TRACES_SAMPLE_RATE")

    expect(() => parseObservabilityEnv(
      {
        DEN_OBSERVABILITY_BACKEND: "sentry",
        SENTRY_DSN: "https://public@sentry.example.test/123",
        SENTRY_URL: "not a url",
      },
      { serviceName: "den-api" },
    )).toThrow("SENTRY_URL")
  })
})

describe("json stdout logger", () => {
  test("writes backend-neutral structured JSON lines", () => {
    const lines: string[] = []
    const logger = createJsonStdoutLogger({
      serviceName: "den-api",
      fields: { component: "observability" },
      now: () => new Date("2026-07-11T12:00:00.000Z"),
      write: (line) => lines.push(line),
    })

    logger.info("started", { port: 8790 })

    expect(lines).toEqual([
      JSON.stringify({
        component: "observability",
        port: 8790,
        timestamp: "2026-07-11T12:00:00.000Z",
        level: "info",
        service: "den-api",
        message: "started",
      }),
    ])
  })
})
