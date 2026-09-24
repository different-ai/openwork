import { afterEach, describe, expect, test } from "bun:test";

import { captureServerException, isExpectedRequestCancellation } from "./telemetry.js";

const originalTelemetry = globalThis.__openworkDesktopTelemetry;

afterEach(() => {
  globalThis.__openworkDesktopTelemetry = originalTelemetry;
});

describe("server telemetry", () => {
  test("drops request-owned cancellation while preserving unrelated fetch failures", () => {
    const captured: unknown[] = [];
    globalThis.__openworkDesktopTelemetry = {
      captureException(error) {
        captured.push(error);
        return true;
      },
    };
    const controller = new AbortController();
    const cancellation = new DOMException("The operation was aborted", "AbortError");
    controller.abort(cancellation);

    expect(captureServerException(cancellation, { requestSignal: controller.signal })).toBe(false);
    expect(captured).toEqual([]);

    const externalFailure = new TypeError("fetch failed");
    expect(captureServerException(externalFailure, { requestSignal: controller.signal })).toBe(true);
    expect(captured).toEqual([externalFailure]);
  });
});

// Fetch abort reasons are arbitrary values, not necessarily Error instances.
test("an explicit null abort reason remains request cancellation", () => {
  const controller = new AbortController();
  controller.abort(null);
  expect(isExpectedRequestCancellation(null, controller.signal)).toBe(true);
  expect(isExpectedRequestCancellation(new Error("unrelated"), controller.signal)).toBe(false);
  expect(isExpectedRequestCancellation(null, new AbortController().signal)).toBe(false);
});
