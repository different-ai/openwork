import { describe, expect, test } from "bun:test";

import type { OpenworkCloudMcpHealth } from "../src/app/lib/openwork-server";
import {
  buildCloudMcpSupportBundle,
  cloudMcpAdvancedRows,
  cloudMcpEngineErrorText,
  cloudMcpEngineRefreshLines,
  cloudMcpProbeTraceLines,
} from "../src/react-app/domains/connections/cloud-mcp-diagnostics";

const CHECKED_AT = "2026-07-22T10:00:00.000Z";

function baseHealth(overrides?: Partial<OpenworkCloudMcpHealth>): OpenworkCloudMcpHealth {
  return {
    schemaVersion: 1,
    phase: "engine_failed",
    usable: false,
    usableByCurrentModel: null,
    connectCatalogEnabled: true,
    workspace: { id: "ws_1", type: "local", directory: "/workspace", path: "/workspace" },
    desired: {
      present: true,
      name: "openwork-cloud",
      revision: "rev_desired_1234567890",
      config: null,
      token: { present: true, metadata: { expiresAt: "2026-07-23T00:00:00.000Z" } },
      org: { id: "org_1", slug: "acme", name: "Acme" },
    },
    delivery: {
      state: "failed",
      desiredRevision: "rev_desired_1234567890",
      appliedRevision: null,
      updatedAt: 1,
      appliedAt: null,
      lastAttemptAt: Date.parse(CHECKED_AT),
      trigger: "desktop-repair",
    },
    engine: { status: "failed", error: "fetch failed" },
    engineInspection: {
      checked: true,
      cloudPresent: true,
      serverCount: 2,
      servers: [
        { name: "openwork-cloud", status: "failed", error: "fetch failed" },
        { name: "sibling", status: "connected" },
      ],
    },
    tools: {
      expected: ["openwork-cloud_search_capabilities", "openwork-cloud_execute_capability"],
      present: [],
      missing: ["openwork-cloud_search_capabilities", "openwork-cloud_execute_capability"],
      direct: {
        checked: false,
        source: "mcp_tools_list",
        expected: ["search_capabilities", "execute_capability"],
        present: [],
        missing: [],
      },
      providerProjection: { checked: false, present: [], missing: [] },
    },
    pluginCanaries: { expected: [], present: [], missing: [] },
    compatibility: {
      openwork: { serverVersion: "0.17.36", app: { version: "0.17.36" } },
      opencode: { expectedVersion: "1.17.11", actualVersion: "1.17.11", probe: "ok" },
      pluginFileHashes: [],
      supportedFeatures: { dynamicMcp: true, directoryScoping: true, toolIds: true, providerToolProjection: false, pluginCanaries: false },
      experimentalToolIds: { checked: false, expected: [], present: [], missing: [], includesMcpTools: null },
      experimentalProviderTools: { checked: false, expected: [], present: [], missing: [], includesMcpTools: null },
    },
    toolDenies: [],
    firstFailure: {
      code: "opencode_mcp_sync_failed",
      stage: "engine_delivery",
      retryable: true,
      recommendedAction: "Retry reconcile or reconnect OpenWork Cloud",
      message: "openwork-cloud MCP connection failed.",
      details: { error: "fetch failed" },
    },
    checkedAt: CHECKED_AT,
    durationMs: 480,
    ...overrides,
  };
}

describe("cloud MCP advanced diagnostics", () => {
  test("surfaces the raw engine error string that OpenCode collapses to", () => {
    expect(cloudMcpEngineErrorText(baseHealth())).toBe("fetch failed");
  });

  test("advanced rows expose failure code, engine detail, sibling servers, token, and timings", () => {
    const rows = cloudMcpAdvancedRows(baseHealth());
    const byLabel = new Map(rows.map((row) => [row.label, row]));

    expect(byLabel.get("Failure")?.value).toBe("opencode_mcp_sync_failed · stage engine_delivery · retryable");
    expect(byLabel.get("Engine MCP status")?.value).toBe("failed — fetch failed");
    expect(byLabel.get("Engine MCP status")?.tone).toBe("error");
    expect(byLabel.get("Engine MCP servers")?.value).toContain("openwork-cloud failed — fetch failed");
    expect(byLabel.get("Engine MCP servers")?.value).toContain("sibling connected");
    expect(byLabel.get("Delivery")?.value).toBe("failed · desired rev_desired_ · applied none · last attempt 2026-07-22T10:00:00.000Z · trigger desktop-repair");
    expect(byLabel.get("Cloud token")?.value).toBe("present · expires 2026-07-23T00:00:00.000Z");
    expect(byLabel.get("Direct endpoint check")?.value).toContain("not run");
    expect(byLabel.get("Checked")?.value).toBe(`${CHECKED_AT} · took 480 ms`);
  });

  test("flags a lost engine registration as the refresh-worthy issue", () => {
    const rows = cloudMcpAdvancedRows(baseHealth({
      engineInspection: { checked: true, cloudPresent: false, serverCount: 0, servers: [] },
      engine: { status: "missing" },
    }));
    const registration = rows.find((row) => row.label === "Engine registration");
    expect(registration?.tone).toBe("error");
    expect(registration?.value).toContain("not registered in the engine");
  });

  test("shows the probe transport cause from the direct check", () => {
    const rows = cloudMcpAdvancedRows(baseHealth({
      tools: {
        ...baseHealth().tools,
        direct: {
          checked: false,
          source: "mcp_tools_list",
          expected: ["search_capabilities", "execute_capability"],
          present: [],
          missing: [],
          failure: {
            code: "probe_unreachable",
            stage: "tool_registration",
            retryable: true,
            recommendedAction: "Check the network path",
            message: "The OpenWork server could not reach the Cloud MCP endpoint.",
            details: {
              transport: {
                message: "fetch failed",
                causes: [{ message: "self signed certificate in certificate chain", code: "SELF_SIGNED_CERT_IN_CHAIN" }],
              },
            },
          },
          trace: {
            endpoint: "https://api.openwork.test/mcp/agent",
            startedAt: CHECKED_AT,
            latencyMs: 42,
            protocolVersion: null,
            serverInfo: null,
            steps: [{ step: "initialize", ok: false, latencyMs: 42, error: { message: "fetch failed" } }],
          },
        },
      },
    }));
    const cause = rows.find((row) => row.label === "Probe transport cause");
    expect(cause?.value).toContain("SELF_SIGNED_CERT_IN_CHAIN");
    expect(rows.find((row) => row.label === "Endpoint")?.value).toBe("https://api.openwork.test/mcp/agent");
  });

  test("formats probe trace and engine refresh step lines", () => {
    expect(cloudMcpProbeTraceLines({
      endpoint: "https://api.openwork.test/mcp/agent",
      startedAt: CHECKED_AT,
      latencyMs: 240,
      protocolVersion: "2025-06-18",
      serverInfo: { name: "openwork-cloud", version: "1.0.0" },
      steps: [
        { step: "initialize", ok: true, httpStatus: 200, latencyMs: 120 },
        { step: "tools_list", ok: false, httpStatus: 502, latencyMs: 88, error: { message: "bad gateway" } },
      ],
    })).toEqual([
      "initialize · ok · HTTP 200 · 120 ms",
      'tools_list · failed · HTTP 502 · 88 ms — {"message":"bad gateway"}',
    ]);

    expect(cloudMcpEngineRefreshLines({
      performed: false,
      reason: "desired_missing",
      trigger: "support-call",
      startedAt: CHECKED_AT,
      finishedAt: CHECKED_AT,
      steps: [],
    })).toEqual(["not performed (desired_missing)"]);

    expect(cloudMcpEngineRefreshLines({
      performed: true,
      trigger: "support-call",
      startedAt: CHECKED_AT,
      finishedAt: CHECKED_AT,
      steps: [
        { step: "engine_disconnect", ok: true, latencyMs: 10 },
        { step: "reapply", ok: false, latencyMs: 900, detail: { code: "opencode_mcp_sync_failed" } },
      ],
    })).toEqual([
      "engine disconnect · ok · 10 ms",
      're-register and verify · failed · 900 ms — {"code":"opencode_mcp_sync_failed"}',
    ]);
  });

  test("support bundle is JSON, carries context, and redacts bearer material", () => {
    const bundle = buildCloudMcpSupportBundle({
      health: baseHealth({
        firstFailure: {
          code: "invalid_mcp_token",
          stage: "transport_auth",
          retryable: false,
          recommendedAction: "Reconnect OpenWork Cloud",
          message: "rejected",
          details: { header: "Bearer owt_super_secret_token_value" },
        },
      }),
      context: {
        workspaceId: "ws_1",
        orgId: "org_1",
        denBaseUrl: "https://app.openwork.test",
        serverBaseUrl: "https://worker.openwork.test",
      },
      capturedAt: CHECKED_AT,
    });

    const parsed = JSON.parse(bundle) as Record<string, unknown>;
    expect(parsed.kind).toBe("openwork-cloud-mcp-diagnostic");
    expect(parsed.capturedAt).toBe(CHECKED_AT);
    expect((parsed.context as Record<string, unknown>).workspaceId).toBe("ws_1");
    expect(bundle).not.toContain("owt_super_secret_token_value");
  });
});
