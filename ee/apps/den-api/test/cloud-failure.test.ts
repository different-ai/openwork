import { describe, expect, test } from "bun:test"
import {
  classifyCloudStartupFailure,
  cloudStartupFailureFromWorker,
  cloudStartupFailureUpdate,
  createCloudStartupFailure,
  publicCloudStartupFailure,
} from "../src/workers/cloud-failure.js"

describe("Cloud startup failure diagnostics", () => {
  test("classifies actionable startup stages without exposing raw provider output", () => {
    expect(classifyCloudStartupFailure(new Error("429 Too Many Requests from provider"))).toBe("provider_rate_limited")
    expect(classifyCloudStartupFailure(new Error("Timed out waiting for Daytona worker health at https://secret.preview/health\nAuthorization: Bearer secret")))
      .toBe("runtime_health_timeout")
    expect(classifyCloudStartupFailure(new Error("openwork session exited with 1\nstderr: token=secret")))
      .toBe("runtime_start_failed")

    const failure = createCloudStartupFailure({
      stage: "recovery",
      error: new Error("openwork session exited with 1\nstderr: token=secret"),
      now: () => new Date("2026-08-28T12:00:00.000Z"),
    })
    const serialized = JSON.stringify(publicCloudStartupFailure(failure))

    expect(serialized).toContain("runtime_start_failed")
    expect(serialized).toContain("recovery")
    expect(serialized).toContain("cwf_")
    expect(serialized).not.toContain("token=secret")
    expect(serialized).not.toContain("Authorization")
  })

  test("round-trips the durable diagnostic fields and clears all of them together", () => {
    const failure = createCloudStartupFailure({
      stage: "provisioning",
      error: new Error("insufficient cpu capacity"),
      now: () => new Date("2026-08-28T13:00:00.000Z"),
    })
    const fields = cloudStartupFailureUpdate(failure)

    expect(cloudStartupFailureFromWorker(fields)).toEqual(failure)
    expect(cloudStartupFailureUpdate(null)).toEqual({
      cloud_failure_code: null,
      cloud_failure_stage: null,
      cloud_failure_reference: null,
      cloud_failure_at: null,
    })
  })
})
