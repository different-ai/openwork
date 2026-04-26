import { afterEach, expect, mock, test } from "bun:test";
import { getTraceApi } from "./otel-api.js";

test("returns otel api when @opentelemetry/api is installed", async () => {
  const api = await getTraceApi();
  // otel packages are in optionalDependencies and installed in this repo
  expect(api).not.toBeNull();
  expect(api!.trace).toBeDefined();
  expect(api!.trace.getTracer).toBeInstanceOf(Function);
});

test("returns same instance on repeated calls", async () => {
  const first = await getTraceApi();
  const second = await getTraceApi();
  expect(first).toBe(second);
});
