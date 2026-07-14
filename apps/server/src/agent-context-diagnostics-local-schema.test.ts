import { describe, expect, test } from "bun:test";

import {
  agentContextDiagnosticsReportSchema as sharedReportSchema,
  agentContextDiagnosticsRequestSchema as sharedRequestSchema,
  type AgentContextDiagnosticsRequest,
} from "@openwork/types/agent-context-diagnostics";

import {
  agentContextDiagnosticsReportSchema as localReportSchema,
  agentContextDiagnosticsRequestSchema as localRequestSchema,
} from "./agent-context-diagnostics-schema.js";
import { runAgentContextDiagnostics } from "./agent-context-diagnostics.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

const validRequest: AgentContextDiagnosticsRequest = {
  organizationConnectionsProbe: { status: "observed", code: null, totalCount: 2, truncated: false },
  organizationConnections: [
    {
      id: "shared.connection",
      name: "Shared connection",
      credentialMode: "shared",
      connected: false,
      connectedForMe: false,
      needsReconnect: false,
      missingFeatureCount: 0,
    },
    {
      id: "member.connection",
      name: "Member connection",
      credentialMode: "per_member",
      connected: true,
      connectedForMe: false,
      needsReconnect: false,
      missingFeatureCount: 0,
    },
  ],
};

const workspace: WorkspaceInfo = {
  id: "remote_openwork_schema_parity",
  name: "Remote OpenWork schema parity",
  path: "",
  preset: "starter",
  workspaceType: "remote",
  remoteType: "openwork",
  baseUrl: "https://remote-openwork.invalid",
  openworkHostUrl: "https://remote-openwork.invalid",
};

const config: ServerConfig = {
  host: "127.0.0.1",
  port: 0,
  configPath: "/unused/schema-parity/server.json",
  token: "owt_schema_parity_client",
  hostToken: "owt_schema_parity_host",
  approval: { mode: "auto", timeoutMs: 1_000 },
  corsOrigins: ["*"],
  workspaces: [workspace],
  authorizedRoots: [],
  readOnly: true,
  startedAt: 0,
  tokenSource: "cli",
  hostTokenSource: "cli",
  logFormat: "pretty",
  logRequests: false,
};

const failFetch: typeof fetch = Object.assign(
  async () => {
    throw new Error("Remote-workspace schema parity must not perform egress");
  },
  { preconnect: fetch.preconnect },
);

describe("agent context diagnostics server-local schema parity", () => {
  test("accepts the same valid request and report as the shared client contract", async () => {
    expect(localRequestSchema.safeParse(validRequest).success).toBe(true);
    expect(sharedRequestSchema.safeParse(validRequest).success).toBe(true);

    const report = await runAgentContextDiagnostics({
      config,
      workspace,
      request: validRequest,
      inspectRegistration: () => "not-recorded",
      dependencies: { fetchImpl: failFetch },
    });

    expect(localReportSchema.safeParse(report).success).toBe(true);
    expect(sharedReportSchema.safeParse(report).success).toBe(true);
    const reportWithCanonicalMcp = {
      ...report,
      mcps: [{
        name: "openwork-cloud",
        source: "config.remote",
        type: "remote",
        enabled: true,
        disabledByTools: false,
        origin: null,
        path: "/mcp/agent",
        hasHeaders: true,
        oauthMode: "disabled",
        syncStatus: "connected",
        liveEngineStatus: "unavailable",
      }],
    };
    expect(localReportSchema.safeParse(reportWithCanonicalMcp).success).toBe(true);
    expect(sharedReportSchema.safeParse(reportWithCanonicalMcp).success).toBe(true);
  });

  test("rejects unsafe and unknown request fields in both contracts", () => {
    const candidates = [
      { ...validRequest, unexpected: true },
      {
        ...validRequest,
        organizationConnections: [
          { ...validRequest.organizationConnections[0], name: "Unsafe\u202ename" },
        ],
      },
      {
        ...validRequest,
        organizationConnections: [
          { ...validRequest.organizationConnections[0], name: "Unsafe Bearer schema-parity-secret" },
        ],
      },
      {
        ...validRequest,
        organizationConnections: [
          { ...validRequest.organizationConnections[0], name: "Unsafe https://private.example.test/mcp?token=schema-parity-secret" },
        ],
      },
      {
        ...validRequest,
        organizationConnections: [
          { ...validRequest.organizationConnections[0], name: "Unsafe /Users/diagnostics/private/connection.json" },
        ],
      },
      {
        ...validRequest,
        organizationConnections: [
          { ...validRequest.organizationConnections[0], name: "Unsafe B\u200bearer q" },
        ],
      },
      {
        ...validRequest,
        organizationConnections: [
          { ...validRequest.organizationConnections[0], name: "Unsafe client%5Fsecret%3Dq" },
        ],
      },
      {
        ...validRequest,
        organizationConnections: [
          { ...validRequest.organizationConnections[0], name: "Unsafe to ken = z" },
        ],
      },
      {
        ...validRequest,
        organizationConnections: [
          { ...validRequest.organizationConnections[0], id: "ow_mcp_at_ZGlhZ25vc3RpY3M" },
        ],
      },
      {
        ...validRequest,
        organizationConnections: [
          { ...validRequest.organizationConnections[0], id: "eyJx.e30.signature" },
        ],
      },
    ];

    for (const candidate of candidates) {
      expect(localRequestSchema.safeParse(candidate).success).toBe(false);
      expect(sharedRequestSchema.safeParse(candidate).success).toBe(false);
    }
  });

  test("rejects unsafe and unknown report fields in both contracts", async () => {
    const report = await runAgentContextDiagnostics({
      config,
      workspace,
      request: validRequest,
      inspectRegistration: () => "not-recorded",
      dependencies: { fetchImpl: failFetch },
    });
    const candidates = [
      { ...report, unexpected: true },
      { ...report, workspace: { ...report.workspace, name: "Unsafe\u202ename" } },
      { ...report, workspace: { ...report.workspace, name: "Unsafe Bearer schema-parity-secret" } },
      { ...report, workspace: { ...report.workspace, name: "Unsafe Bearer q" } },
      { ...report, workspace: { ...report.workspace, name: "Unsafe Be ar er split-secret" } },
      { ...report, workspace: { ...report.workspace, name: "Unsafe https://private.example.test/mcp?token=schema-parity-secret" } },
      { ...report, workspace: { ...report.workspace, name: "Unsafe https%3A%2F%2Fprivate.example.test%2Fmcp%3Ftoken%3Dq" } },
      { ...report, workspace: { ...report.workspace, name: "Unsafe /Users/diagnostics/private/workspace" } },
      { ...report, workspace: { ...report.workspace, name: "Unsafe %2FUsers%2Fdiagnostics%2Fprivate" } },
      {
        ...report,
        mcps: [{
          name: "openwork-cloud",
          source: "config.remote",
          type: "remote",
          enabled: true,
          disabledByTools: false,
          origin: null,
          path: "/nested/mcp/agent",
          hasHeaders: true,
          oauthMode: "disabled",
          syncStatus: "connected",
          liveEngineStatus: "unavailable",
        }],
      },
    ];

    for (const candidate of candidates) {
      expect(localReportSchema.safeParse(candidate).success).toBe(false);
      expect(sharedReportSchema.safeParse(candidate).success).toBe(false);
    }
  });
});
