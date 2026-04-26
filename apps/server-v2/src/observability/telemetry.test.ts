import { afterEach, expect, test } from "bun:test";
import {
  initTelemetry,
  isTelemetryConfigured,
  resetTelemetryStateForTesting,
  shutdownTelemetry,
} from "./telemetry.js";

afterEach(() => {
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  delete process.env.OTEL_SDK_DISABLED;
  delete process.env.OTEL_SERVICE_NAME;
  resetTelemetryStateForTesting();
});

test("isTelemetryConfigured is false without OTEL_EXPORTER_OTLP_ENDPOINT", () => {
  expect(isTelemetryConfigured()).toBe(false);
});

test("OTEL_SDK_DISABLED forces telemetry off even with an endpoint set", () => {
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://example.test";
  process.env.OTEL_SDK_DISABLED = "1";
  expect(isTelemetryConfigured()).toBe(false);
});

test("initTelemetry is a no-op when not configured", async () => {
  const enabled = await initTelemetry();
  expect(enabled).toBe(false);
});

test("shutdownTelemetry is idempotent when nothing is running", async () => {
  await shutdownTelemetry();
  await shutdownTelemetry();
});
