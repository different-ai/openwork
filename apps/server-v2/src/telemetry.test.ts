import { afterEach, beforeEach, expect, test } from "bun:test";
import { initTelemetry, shutdownTelemetry } from "./telemetry.js";

let originalEnv: string | undefined;

beforeEach(() => {
  originalEnv = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
});

afterEach(async () => {
  if (originalEnv === undefined) {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  } else {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = originalEnv;
  }
  await shutdownTelemetry();
});

test("initTelemetry is a no-op without OTEL_EXPORTER_OTLP_ENDPOINT", async () => {
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  // should not throw
  await initTelemetry();
});

test("shutdownTelemetry is idempotent", async () => {
  await shutdownTelemetry();
  await shutdownTelemetry();
  // no throw on double shutdown
});

test("initTelemetry does not throw with unreachable endpoint", async () => {
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:19999";
  // should init without throwing even if endpoint is down
  // traces will fail to export but the app keeps running
  await initTelemetry();
});
