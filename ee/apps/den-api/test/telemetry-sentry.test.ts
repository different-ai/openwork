import { describe, expect, test } from "bun:test"

import {
  CloudMcpReconciliationFailure,
  captureTelemetrySentryEvent,
  cloudMcpFailureSentryFields,
} from "../src/routes/telemetry/sentry-events.js"

describe("telemetry Sentry promotion", () => {
  test("captures a Cloud MCP failure with only allowlisted diagnostic fields", () => {
    const captured: Array<{
      error: unknown
      fields?: Readonly<Record<string, unknown>>
    }> = []
    const event = {
      type: "connect.mcp_failed",
      source: "app",
      durationMs: 480,
      dimensions: [
        { type: "cloud_mcp.failure_code", value: "opencode_mcp_sync_failed", label: "member@example.com" },
        { type: "cloud_mcp.failure_stage", value: "engine_delivery", label: "Bearer private-token" },
        { type: "cloud_mcp.retryable", value: "true", label: "true" },
        { type: "cloud_mcp.health_phase", value: "engine_failed", label: "engine_failed" },
        { type: "cloud_mcp.engine_status", value: "failed", label: "failed" },
        { type: "cloud_mcp.delivery_state", value: "failed", label: "failed" },
        { type: "cloud_mcp.direct_probe", value: "initialize_http_401", label: "initialize_http_401" },
        {
          type: "cloud_mcp.versions",
          value: "app_0.18.12__server_0.18.12__engine_1.17.11",
          label: "app_0.18.12__server_0.18.12__engine_1.17.11",
          metadata: { secret: "private-diagnostic-payload" },
        },
        { type: "untrusted.private_context", value: "should_not_pass", label: "private.customer.example" },
      ],
    }

    expect(captureTelemetrySentryEvent(event, (error, fields) => {
      captured.push({ error, fields })
    })).toBe(true)
    expect(captured).toHaveLength(1)
    expect(captured[0]?.error).toBeInstanceOf(CloudMcpReconciliationFailure)
    expect(captured[0]?.fields).toEqual({
      component: "openwork_cloud_mcp",
      event_type: "connect.mcp_failed",
      source: "app",
      duration_ms: 480,
      failure_code: "opencode_mcp_sync_failed",
      failure_stage: "engine_delivery",
      retryable: "true",
      health_phase: "engine_failed",
      engine_status: "failed",
      delivery_state: "failed",
      direct_probe: "initialize_http_401",
      versions: "app_0.18.12__server_0.18.12__engine_1.17.11",
    })
    const serialized = JSON.stringify(captured)
    expect(serialized).not.toContain("member@example.com")
    expect(serialized).not.toContain("private-token")
    expect(serialized).not.toContain("private-diagnostic-payload")
    expect(serialized).not.toContain("private.customer.example")
    expect(serialized).not.toContain("should_not_pass")
  })

  test("ignores unrelated telemetry and contains reporter failures", () => {
    expect(captureTelemetrySentryEvent({ type: "task.failed" }, () => {
      throw new Error("should not run")
    })).toBe(false)
    expect(captureTelemetrySentryEvent({ type: "connect.mcp_failed" }, () => {
      throw new Error("Sentry unavailable")
    })).toBe(false)
  })

  test("maps schema-shaped but unknown classifications to safe fallbacks", () => {
    const fields = cloudMcpFailureSentryFields({
      type: "connect.mcp_failed",
      dimensions: [
        { type: "cloud_mcp.failure_code", value: "member_example.com", label: "member@example.com" },
        { type: "cloud_mcp.failure_stage", value: "private_customer", label: "private_customer" },
        { type: "cloud_mcp.health_phase", value: "private_customer", label: "private_customer" },
        { type: "cloud_mcp.engine_status", value: "private_customer", label: "private_customer" },
        { type: "cloud_mcp.delivery_state", value: "private_customer", label: "private_customer" },
        { type: "cloud_mcp.direct_probe", value: "private_customer", label: "private_customer" },
        { type: "cloud_mcp.versions", value: "private_customer", label: "private_customer" },
      ],
    })

    expect(fields).toMatchObject({
      failure_code: "connect_failure",
      failure_stage: "unknown",
      health_phase: "unknown",
      engine_status: "unknown",
      delivery_state: "unknown",
      direct_probe: "unknown",
      versions: "unknown",
    })
    const serialized = JSON.stringify(fields)
    expect(serialized).not.toContain("member")
    expect(serialized).not.toContain("private")
  })
})
