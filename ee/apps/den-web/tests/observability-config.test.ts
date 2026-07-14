import { describe, expect, test } from "bun:test";
import { SpanStatusCode, TraceFlags } from "@opentelemetry/api";
import type { SpanContext } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { readFileSync } from "node:fs";

import { parseBrowserObservabilityEnv } from "../observability/browser-config";
import { scrubOtelSpan } from "../observability/otel-node";
import { scrubSentryEvent, scrubSentrySpan, scrubText } from "../observability/scrub";
import { getDenWebObservabilityConfig, resolveInstrumentationActionForBackend } from "../observability/server-config";
import {
  isTelemetrySdkStarted,
  registerRetainedTelemetryShutdownHandlers,
  resetDenWebObservabilityStateForTests,
  retainTelemetrySdk,
  shutdownRetainedTelemetry,
} from "../observability/runtime-logger";
import type { TelemetryShutdownSignal } from "../observability/runtime-logger";
import {
  shouldUploadSentrySourceMaps,
  validateBuildObservabilityEnv,
  validateBrowserObservabilityEnv,
  withObservabilityNextConfig,
} from "../observability/next-config-observability.cjs";

function readAppFile(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
        return;
      }
      reject(error);
    });
  });
}

type SignalListener = () => void;

class FakeSignalTarget {
  readonly listeners: { SIGTERM: SignalListener[]; SIGINT: SignalListener[] } = { SIGTERM: [], SIGINT: [] };

  on(signal: TelemetryShutdownSignal, listener: SignalListener): void {
    this.listeners[signal].push(listener);
  }

  emit(signal: TelemetryShutdownSignal): void {
    for (const listener of this.listeners[signal]) {
      listener();
    }
  }
}

function serverPort(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected a TCP server address");
  }
  return address.port;
}

function makeFinishedReadableSpan(): ReadableSpan {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: "den-web-test" }),
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const linkContext: SpanContext = {
    traceId: "11111111111111111111111111111111",
    spanId: "2222222222222222",
    traceFlags: TraceFlags.SAMPLED,
  };

  const tracer = provider.getTracer("den-web-test", "1.0.0", { schemaUrl: "https://schema.example.test" });
  const span = tracer.startSpan("GET /api/den/v1/me?token=secret", {
    attributes: {
      authorization: "Bearer secret",
      "http.url": "https://api.example.test/v1/me?token=secret",
    },
    links: [{
      context: linkContext,
      attributes: { authorization: "Bearer secret" },
    }],
  });
  span.addEvent("fetch /api/den/v1/me?token=secret", { cookie: "sid=secret" });
  span.setStatus({ code: SpanStatusCode.ERROR, message: "failed token=secret" });
  span.end();

  const finished = exporter.getFinishedSpans()[0];
  if (finished === undefined) {
    throw new Error("Expected a finished span");
  }
  return finished;
}

async function exportSpanToLocalOtlp(span: ReadableSpan): Promise<Buffer[]> {
  const requests: Buffer[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      requests.push(Buffer.concat(chunks));
      response.writeHead(200, { "content-type": "application/x-protobuf" });
      response.end();
    });
  });

  await listen(server);
  const exporter = new OTLPTraceExporter({ url: `http://127.0.0.1:${serverPort(server)}/v1/traces` });
  try {
    await new Promise<void>((resolve, reject) => {
      exporter.export([span], (result) => {
        if (result.error !== undefined) {
          reject(result.error);
          return;
        }
        if (result.code !== 0) {
          reject(new Error("OTLP trace export failed"));
          return;
        }
        resolve();
      });
    });
  } finally {
    await exporter.shutdown();
    await close(server);
  }

  return requests;
}

describe("den-web observability backend dispatch", () => {
  test("selects exactly one runtime initializer", () => {
    expect(resolveInstrumentationActionForBackend("otel", "nodejs")).toBe("otel-node");
    expect(resolveInstrumentationActionForBackend("otel", "edge")).toBe("none");
    expect(resolveInstrumentationActionForBackend("sentry", "nodejs")).toBe("sentry-server");
    expect(resolveInstrumentationActionForBackend("sentry", "edge")).toBe("sentry-edge");
    expect(resolveInstrumentationActionForBackend("none", "nodejs")).toBe("none");
  });

  test("honors OTEL_SERVICE_NAME with a den-web default", () => {
    expect(getDenWebObservabilityConfig({}).serviceName).toBe("den-web");
    expect(getDenWebObservabilityConfig({ OTEL_SERVICE_NAME: " den-web-custom " }).serviceName).toBe("den-web-custom");
  });

  test("keeps browser Sentry explicitly public and treats browser OTEL as disabled", () => {
    expect(parseBrowserObservabilityEnv({}).backend).toBe("none");
    expect(parseBrowserObservabilityEnv({ backend: "otel" })).toEqual({
      backend: "none",
      disabledReason: "Browser OpenTelemetry is disabled; DEN OTEL is server-only.",
    });
    expect(parseBrowserObservabilityEnv({
      backend: "sentry",
      sentryDsn: "https://public@sentry.example.test/123",
      sentryTracesSampleRate: "0.5",
    })).toEqual({
      backend: "sentry",
      dsn: "https://public@sentry.example.test/123",
      tracesSampleRate: 0.5,
    });
    expect(() => parseBrowserObservabilityEnv({
      backend: "sentry",
    })).toThrow("NEXT_PUBLIC_SENTRY_DSN");
  });

  test("keeps NodeSDK imports out of the Edge instrumentation graph", () => {
    const instrumentation = readAppFile("instrumentation.ts");

    expect(instrumentation).toContain('if (process.env.NEXT_RUNTIME === "nodejs")');
    expect(instrumentation).toContain('await import("./observability/otel-node")');
    expect(instrumentation).not.toContain('from "./observability/otel-node"');
  });

  test("keeps browser public env reads directly inlineable by Next", () => {
    expect(readAppFile("instrumentation-client.ts")).toContain("process.env.NEXT_PUBLIC_DEN_OBSERVABILITY_BACKEND");
    expect(readAppFile("app/global-error.tsx")).toContain("process.env.NEXT_PUBLIC_DEN_OBSERVABILITY_BACKEND");
  });

  test("retains telemetry runtime state on globalThis and uses the 0.220 log processor constructor", () => {
    expect(readAppFile("observability/runtime-logger.ts")).toContain("globalThis.__denWebObservabilityState");
    const otelNode = readAppFile("observability/otel-node.ts");
    expect(otelNode).toContain("new BatchLogRecordProcessor({");
    expect(otelNode).toContain("exporter: new OTLPLogExporter");
  });

  test("registers bounded OTEL shutdown signal handlers once globally", async () => {
    resetDenWebObservabilityStateForTests();
    const target = new FakeSignalTarget();
    let flushes = 0;
    let shutdowns = 0;
    retainTelemetrySdk({
      forceFlush: async () => {
        flushes += 1;
      },
      shutdown: async () => {
        shutdowns += 1;
      },
    });

    expect(registerRetainedTelemetryShutdownHandlers(target, 25)).toBe(true);
    expect(registerRetainedTelemetryShutdownHandlers(target, 25)).toBe(false);
    expect(target.listeners.SIGTERM).toHaveLength(1);
    expect(target.listeners.SIGINT).toHaveLength(1);

    target.emit("SIGTERM");
    await shutdownRetainedTelemetry(25);

    expect(flushes).toBe(1);
    expect(shutdowns).toBe(1);
    expect(isTelemetrySdkStarted()).toBe(false);

    target.emit("SIGINT");
    await shutdownRetainedTelemetry(25);
    expect(flushes).toBe(1);
    expect(shutdowns).toBe(1);
  });

  test("bounds stuck OTEL flushes and still attempts shutdown", async () => {
    resetDenWebObservabilityStateForTests();
    let shutdowns = 0;
    retainTelemetrySdk({
      forceFlush: () => new Promise(() => {}),
      shutdown: async () => {
        shutdowns += 1;
      },
    });

    await shutdownRetainedTelemetry(5);
    expect(shutdowns).toBe(1);
    expect(isTelemetrySdkStarted()).toBe(false);
  });
});

describe("den-web observability scrubbing", () => {
  test("removes query strings and obvious secrets from telemetry text", () => {
    expect(scrubText("GET https://api.example.test/v1/me?token=secret&email=a@example.test Authorization: Bearer abc123")).toBe(
      "GET https://api.example.test/v1/me?[redacted-query] Authorization: [redacted]",
    );
    expect(scrubText('body: {"token":"secret","password":"pw"} cookie: sid=secret')).toBe(
      "body: [redacted]",
    );
  });

  test("scrubs Sentry events and spans before export", () => {
    const event = scrubSentryEvent({
      message: "failed /api/den/v1/me?token=secret",
      transaction: "GET /api/den/v1/me?include=org",
      request: {
        url: "https://app.example.test/api/den/v1/me?include=org",
        headers: { authorization: "Bearer secret", cookie: "sid=secret" },
        cookies: { sid: "secret" },
        data: { token: "secret" },
        query_string: "include=org",
      },
      breadcrumbs: [{ message: "cookie: sid=secret", data: { token: "secret" } }],
      user: { email: "person@example.test" },
    });

    expect(event).toEqual({
      message: "failed /api/den/v1/me?[redacted-query]",
      transaction: "GET /api/den/v1/me?[redacted-query]",
      request: {
        url: "https://app.example.test/api/den/v1/me?[redacted-query]",
        headers: {},
      },
      breadcrumbs: [{ message: "cookie: [redacted]", data: { token: "[redacted]" } }],
      user: undefined,
    });

    expect(scrubSentrySpan({
      description: "fetch https://api.example.test/v1/me?token=secret",
      data: { authorization: "Bearer secret" },
    })).toEqual({
      description: "fetch https://api.example.test/v1/me?[redacted-query]",
      data: "[redacted]",
    });
  });

  test("scrubs Sentry exception, logentry, context, thread, and breadcrumb payloads", () => {
    const event = scrubSentryEvent({
      message: "global error /api/auth/callback?code=super-secret",
      logentry: {
        message: "log /api/den/v1/me?token=super-secret",
        formatted: "body: super-secret",
        params: ["Authorization: Bearer super-secret"],
      },
      exception: {
        values: [{
          type: "Error",
          value: "failed /api/den/v1/me?token=super-secret body: super-secret",
          stacktrace: {
            frames: [{
              filename: "https://app.example.test/page?token=super-secret",
              context_line: "cookie: sid=super-secret",
              vars: { token: "super-secret", body: { token: "super-secret" } },
            }],
          },
        }],
      },
      contexts: {
        request: {
          url: "https://app.example.test/api/den?token=super-secret",
          body: { token: "super-secret" },
          query_string: "token=super-secret",
        },
      },
      threads: {
        values: [{
          name: "worker token=super-secret",
          stacktrace: {
            frames: [{
              abs_path: "https://app.example.test/worker.js?token=super-secret",
              context_line: "Authorization: Bearer super-secret",
            }],
          },
        }],
      },
      breadcrumbs: [{
        message: "POST /api/den?token=super-secret",
        data: { body: "super-secret", authorization: "Bearer super-secret" },
      }],
    });

    if (event === null) {
      throw new Error("Expected sanitized event");
    }

    expect(event.message).toBe("global error /api/auth/callback?[redacted-query]");
    expect(event.logentry?.message).toBe("log /api/den/v1/me?[redacted-query]");
    expect(event.exception?.values?.[0]?.value).toBe("failed /api/den/v1/me?[redacted-query] body: [redacted]");
    expect(event.threads?.values?.[0]?.name).toBe("worker token=[redacted]");
    expect(JSON.stringify(event)).not.toContain("super-secret");
  });

  test("scrubs OTEL spans without dropping methods required by OTLP serialization", async () => {
    const span = makeFinishedReadableSpan();
    const sanitized = scrubOtelSpan(span);

    expect(Object.getPrototypeOf(sanitized)).toBe(Object.getPrototypeOf(span));
    expect(sanitized.spanContext()).toEqual(span.spanContext());
    expect(sanitized.resource).toBe(span.resource);
    expect(sanitized.instrumentationScope).toBe(span.instrumentationScope);
    expect(sanitized.name).toBe("GET /api/den/v1/me?[redacted-query]");
    expect(sanitized.status.message).toBe("failed token=[redacted]");
    expect(sanitized.attributes.authorization).toBe("[redacted]");
    expect(sanitized.attributes["http.url"]).toBe("https://api.example.test/v1/me?[redacted-query]");

    const event = sanitized.events[0];
    if (event === undefined) {
      throw new Error("Expected a sanitized event");
    }
    expect(event.name).toBe("fetch /api/den/v1/me?[redacted-query]");
    expect(event.attributes?.cookie).toBe("[redacted]");

    const link = sanitized.links[0];
    if (link === undefined) {
      throw new Error("Expected a sanitized link");
    }
    expect(link.attributes?.authorization).toBe("[redacted]");

    expect(span.name).toBe("GET /api/den/v1/me?token=secret");
    expect(span.status.message).toBe("failed token=secret");
    expect(span.attributes.authorization).toBe("Bearer secret");

    const requests = await exportSpanToLocalOtlp(sanitized);
    const request = requests[0];
    if (request === undefined) {
      throw new Error("Expected a local OTLP request");
    }
    expect(request.byteLength).toBeGreaterThan(0);
  });
});

describe("den-web observability Next config", () => {
  test("does not wrap normal none-mode builds", () => {
    const config = { reactStrictMode: true };
    expect(shouldUploadSentrySourceMaps({ DEN_OBSERVABILITY_BACKEND: "none" })).toBe(false);
    expect(withObservabilityNextConfig(config, { DEN_OBSERVABILITY_BACKEND: "none" }, () => {
      throw new Error("Sentry wrapper should not load");
    })).toBe(config);
  });

  test("does not require runtime Sentry secrets or wrap generic runtime images", () => {
    const config = { reactStrictMode: true };

    expect(validateBuildObservabilityEnv({
      DEN_OBSERVABILITY_BACKEND: "sentry",
      SENTRY_DSN: "runtime-dsn-is-validated-at-runtime",
    })).toMatchObject({
      serverBackend: "sentry",
      sentryConfigWrapEnabled: false,
      sourceMapUploadsEnabled: false,
    });
    expect(withObservabilityNextConfig(config, {
      DEN_OBSERVABILITY_BACKEND: "sentry",
      SENTRY_DSN: "runtime-dsn-is-validated-at-runtime",
    }, () => {
      throw new Error("Sentry wrapper should not load");
    })).toBe(config);
  });

  test("wraps browser Sentry builds without server runtime secrets and disables source-map upload", () => {
    const config = { reactStrictMode: true };
    const wrapped = withObservabilityNextConfig(config, {
      NEXT_PUBLIC_DEN_OBSERVABILITY_BACKEND: "sentry",
      NEXT_PUBLIC_SENTRY_DSN: "https://public@sentry.example.test/123",
    }, (nextConfig, sentryOptions) => ({ nextConfig, sentryOptions }));

    expect(wrapped).toEqual({
      nextConfig: config,
      sentryOptions: expect.objectContaining({
        sourcemaps: { disable: true },
        release: expect.objectContaining({ create: false, finalize: false }),
        widenClientFileUpload: false,
      }),
    });
    expect("authToken" in wrapped.sentryOptions).toBe(false);
  });

  test("requires complete Sentry build credentials only when source-map uploads are enabled", () => {
    expect(() => validateBuildObservabilityEnv({
      DEN_WEB_UPLOAD_SENTRY_SOURCEMAPS: "true",
    })).toThrow("SENTRY_AUTH_TOKEN");

    expect(shouldUploadSentrySourceMaps({
      SENTRY_AUTH_TOKEN: "secret-token",
      SENTRY_ORG: "openwork",
      SENTRY_PROJECT: "den-web",
    })).toBe(false);
  });

  test("wraps source-map uploads only when the build-only upload flag is enabled", () => {
    const config = { reactStrictMode: true };
    const wrapped = withObservabilityNextConfig(config, {
      DEN_WEB_UPLOAD_SENTRY_SOURCEMAPS: "true",
      SENTRY_AUTH_TOKEN: "secret-token",
      SENTRY_ORG: "openwork",
      SENTRY_PROJECT: "den-web",
      SENTRY_URL: "https://sentry.example.test",
    }, (nextConfig, sentryOptions) => ({ nextConfig, sentryOptions }));

    expect(wrapped).toEqual({
      nextConfig: config,
      sentryOptions: expect.objectContaining({
        org: "openwork",
        project: "den-web",
        authToken: "secret-token",
        sentryUrl: "https://sentry.example.test",
        silent: true,
        sourcemaps: { disable: false },
        widenClientFileUpload: true,
        disableLogger: true,
      }),
    });
    expect(shouldUploadSentrySourceMaps({
      DEN_WEB_UPLOAD_SENTRY_SOURCEMAPS: "true",
      SENTRY_AUTH_TOKEN: "secret-token",
      SENTRY_ORG: "openwork",
      SENTRY_PROJECT: "den-web",
    })).toBe(true);
  });

  test("validates backend compatibility matrix at build time", () => {
    expect(validateBuildObservabilityEnv({
      DEN_OBSERVABILITY_BACKEND: "otel",
      NEXT_PUBLIC_DEN_OBSERVABILITY_BACKEND: "otel",
    })).toMatchObject({
      serverBackend: "otel",
      browserBackend: "otel",
      browserEffectiveBackend: "none",
      sentryConfigWrapEnabled: false,
      sourceMapUploadsEnabled: false,
    });

    expect(validateBrowserObservabilityEnv({
      DEN_OBSERVABILITY_BACKEND: "otel",
      NEXT_PUBLIC_DEN_OBSERVABILITY_BACKEND: "sentry",
      NEXT_PUBLIC_SENTRY_DSN: "https://public@sentry.example.test/123",
    })).toMatchObject({
      serverBackend: "otel",
      browserBackend: "sentry",
      browserEffectiveBackend: "sentry",
      sentryConfigWrapEnabled: true,
    });

    expect(() => validateBrowserObservabilityEnv({
      NEXT_PUBLIC_DEN_OBSERVABILITY_BACKEND: "sentry",
    })).toThrow("NEXT_PUBLIC_SENTRY_DSN");
  });
});
