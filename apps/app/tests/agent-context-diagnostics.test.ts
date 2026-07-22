import { describe, expect, test } from "bun:test";
import { agentContextDiagnosticsRequestSchema } from "@openwork/types/agent-context-diagnostics";

import {
  collectAgentContextDiagnosticObservations,
  isAgentContextDiagnosticsWorkspaceAllowed,
  resolveOrganizationConnectionsProbe,
  summarizeOrganizationConnections,
} from "../src/app/lib/agent-context-diagnostics";
import type { DenExternalMcpConnection } from "../src/app/lib/den";

const connection = {
  id: "externalMcpConnection_123",
  name: "Customer search",
  url: "https://provider.example.test/mcp?secret=hidden",
  authType: "oauth",
  credentialMode: "per_member",
  connected: true,
  connectedAt: null,
  connectedForMe: true,
  needsReconnect: false,
  missingFeatures: ["files"],
} satisfies DenExternalMcpConnection;

describe("organization connection diagnostic observations", () => {
  test("maps only safe name and readiness fields", () => {
    const summaries = summarizeOrganizationConnections([connection]);
    expect(summaries).toEqual([{
      id: "externalMcpConnection_123",
      name: "Customer search",
      credentialMode: "per_member",
      connected: true,
      connectedForMe: true,
      needsReconnect: false,
      missingFeatureCount: 1,
    }]);
    const serialized = JSON.stringify(summaries);
    expect(serialized).not.toContain("provider.example.test");
    expect(serialized).not.toContain("secret=hidden");
  });

  test("redacts unsafe text from client-observed names while preserving safe identifiers", () => {
    const summaries = summarizeOrganizationConnections([
      {
        ...connection,
        id: "externalMcpConnection_controls",
        name: "Customer\n\u061c\u200e\u202esearch",
      },
      {
        ...connection,
        id: "externalMcpConnection_bearer",
        name: "Customer search redaction-bearer-label Bearer diag-secret-authorization-canary-74ab",
      },
      {
        ...connection,
        id: "externalMcpConnection_url",
        name: "Customer search redaction-url-label https://private.example.test/mcp?access_token=diag-secret-url-canary",
      },
      {
        ...connection,
        id: "externalMcpConnection_path",
        name: "Customer search redaction-path-label /Users/diagnostics/private/connection.json",
      },
    ]);
    expect(summaries).toHaveLength(4);
    expect(summaries[0]?.name).toBe("Customersearch");
    expect(summaries[1]?.name).toBe("[redacted-sensitive-label]");
    expect(summaries[2]?.name).toBe("[redacted-sensitive-label]");
    expect(summaries[3]?.name).toBe("[redacted-sensitive-label]");
    const serialized = JSON.stringify(summaries);
    expect(serialized).not.toContain("diag-secret-authorization-canary-74ab");
    expect(serialized).not.toContain("diag-secret-url-canary");
    expect(serialized).not.toContain("/Users/diagnostics/private/connection.json");
    expect(agentContextDiagnosticsRequestSchema.safeParse({
      organizationConnectionsProbe: {
        status: "observed",
        code: null,
        totalCount: 4,
        truncated: false,
      },
      organizationConnections: summaries,
    }).success).toBe(true);
  });

  test("fails closed for a control-obfuscated organization credential", () => {
    const summaries = summarizeOrganizationConnections([{
      ...connection,
      name: "Customer Bearer\u202ediag-secret-control-canary",
    }]);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.name).toBe("[redacted-sensitive-label]");
    expect(JSON.stringify(summaries)).not.toContain("diag-secret-control-canary");
  });

  test("omits token-shaped or overlength connection IDs without truncation collisions", () => {
    const collisionPrefix = `externalMcpConnection_${"a".repeat(160 - "externalMcpConnection_".length)}`;
    const unsafeConnections = [
      { ...connection, id: "ow_mcp_at_ZGlhZ25vc3RpY3M", name: "Token-shaped ID" },
      { ...connection, id: "eyJx.e30.signature", name: "JWT-shaped ID" },
      {
        ...connection,
        id: `eyJhbGciOiJIUzI1NiJ9.${"a".repeat(170)}.signature`,
        name: "Long JWT-shaped ID",
      },
      { ...connection, id: `${collisionPrefix}x`, name: "Overlength collision A" },
      { ...connection, id: `${collisionPrefix}y`, name: "Overlength collision B" },
      { ...connection, id: "externalMcpConnection_safe", name: "Safe connection" },
    ];
    expect(summarizeOrganizationConnections(unsafeConnections)).toEqual([
      expect.objectContaining({ id: "externalMcpConnection_safe" }),
    ]);

    const request = collectAgentContextDiagnosticObservations({
      organizationConnections: unsafeConnections,
      organizationConnectionsProbe: {
        status: "observed",
        code: null,
        totalCount: 0,
        truncated: false,
      },
      workspaceType: "local",
    });
    expect(request.organizationConnections).toEqual([
      expect.objectContaining({ id: "externalMcpConnection_safe" }),
    ]);
    expect(request.organizationConnectionsProbe).toEqual({
      status: "observed",
      code: null,
      totalCount: 6,
      truncated: true,
    });
    expect(agentContextDiagnosticsRequestSchema.safeParse(request).success).toBe(true);
  });

  test("sends no stale rows when the organization list was not observed", () => {
    const request = collectAgentContextDiagnosticObservations({
      organizationConnections: [connection],
      organizationConnectionsProbe: {
        status: "unavailable",
        code: "list_failed",
        totalCount: 0,
        truncated: false,
      },
      workspaceType: "local",
    });
    expect(request).toEqual({
      organizationConnectionsProbe: {
        status: "unavailable",
        code: "list_failed",
        totalCount: 0,
        truncated: false,
      },
      organizationConnections: [],
    });
  });

  test("includes a verified empty list only after a successful observation", () => {
    const request = collectAgentContextDiagnosticObservations({
      organizationConnections: [],
      organizationConnectionsProbe: {
        status: "observed",
        code: null,
        totalCount: 0,
        truncated: false,
      },
      workspaceType: "local",
    });
    expect(request).toEqual({
      organizationConnectionsProbe: {
        status: "observed",
        code: null,
        totalCount: 0,
        truncated: false,
      },
      organizationConnections: [],
    });
    expect(agentContextDiagnosticsRequestSchema.safeParse(request).success).toBe(true);
  });

  test("bounds local observations to 200 rows and reports deterministic truncation metadata", () => {
    const connections = Array.from({ length: 205 }, (_, index) => ({
      ...connection,
      id: `externalMcpConnection_${String(index).padStart(3, "0")}`,
      name: `Connection ${index}`,
    }));
    const request = collectAgentContextDiagnosticObservations({
      organizationConnections: connections,
      organizationConnectionsProbe: {
        status: "observed",
        code: null,
        totalCount: 0,
        truncated: false,
      },
      workspaceType: "local",
    });
    expect(request.organizationConnections).toHaveLength(200);
    expect(request.organizationConnections[0]?.id).toBe("externalMcpConnection_000");
    expect(request.organizationConnections[199]?.id).toBe("externalMcpConnection_199");
    expect(request.organizationConnectionsProbe).toEqual({
      status: "observed",
      code: null,
      totalCount: 205,
      truncated: true,
    });
    expect(agentContextDiagnosticsRequestSchema.safeParse(request).success).toBe(true);
  });

  test("omits local organization topology from remote OpenWork diagnostic requests", () => {
    const request = collectAgentContextDiagnosticObservations({
      organizationConnections: [connection],
      organizationConnectionsProbe: {
        status: "observed",
        code: null,
        totalCount: 0,
        truncated: false,
      },
      workspaceType: "remote",
    });
    expect(request).toEqual({
      organizationConnectionsProbe: {
        status: "skipped",
        code: "remote_workspace_privacy",
        totalCount: 0,
        truncated: false,
      },
      organizationConnections: [],
    });
    const serialized = JSON.stringify(request);
    expect(serialized).not.toContain(connection.id);
    expect(serialized).not.toContain(connection.name);
    expect(agentContextDiagnosticsRequestSchema.safeParse(request).success).toBe(true);
  });

  test("distinguishes observed, signed-out, loading, and failed reads", () => {
    expect(resolveOrganizationConnectionsProbe({
      signedIn: true,
      activeOrganizationId: "org_test",
      loading: false,
      loaded: true,
      error: null,
    })).toEqual({ status: "observed", code: null, totalCount: 0, truncated: false });
    expect(resolveOrganizationConnectionsProbe({
      signedIn: false,
      activeOrganizationId: null,
      loading: false,
      loaded: true,
      error: null,
    })).toEqual({
      status: "skipped",
      code: "signed_out",
      totalCount: 0,
      truncated: false,
    });
    expect(resolveOrganizationConnectionsProbe({
      signedIn: true,
      activeOrganizationId: "org_test",
      loading: true,
      loaded: false,
      error: null,
    })).toEqual({
      status: "skipped",
      code: "not_attempted",
      totalCount: 0,
      truncated: false,
    });
    expect(resolveOrganizationConnectionsProbe({
      signedIn: true,
      activeOrganizationId: "org_test",
      loading: false,
      loaded: true,
      error: "private upstream body",
    })).toEqual({
      status: "unavailable",
      code: "list_failed",
      totalCount: 0,
      truncated: false,
    });
  });

  test("the request schema rejects client cloud credentials and extra fields", () => {
    const result = agentContextDiagnosticsRequestSchema.safeParse({
      organizationConnectionsProbe: {
        status: "observed",
        code: null,
        totalCount: 0,
        truncated: false,
      },
      organizationConnections: [],
      cloudCatalogProbe: {
        token: "must-never-cross",
        url: "https://provider.example.test/mcp",
      },
    });
    expect(result.success).toBe(false);
  });

  test("the request schema rejects organization rows without an observed probe", () => {
    const result = agentContextDiagnosticsRequestSchema.safeParse({
      organizationConnectionsProbe: {
        status: "skipped",
        code: "signed_out",
        totalCount: 0,
        truncated: false,
      },
      organizationConnections: [{
        id: "externalMcpConnection_123",
        name: "Customer search",
        credentialMode: "per_member",
        connected: true,
        connectedForMe: true,
        needsReconnect: false,
        missingFeatureCount: 0,
      }],
    });
    expect(result.success).toBe(false);
  });

  test("the request schema rejects duplicate organization connection IDs", () => {
    const summary = {
      id: "externalMcpConnection_123",
      name: "Customer search",
      credentialMode: "per_member" as const,
      connected: true,
      connectedForMe: true,
      needsReconnect: false,
      missingFeatureCount: 0,
    };
    const result = agentContextDiagnosticsRequestSchema.safeParse({
      organizationConnectionsProbe: {
        status: "observed",
        code: null,
        totalCount: 2,
        truncated: false,
      },
      organizationConnections: [summary, { ...summary, name: "Customer files" }],
    });
    expect(result.success).toBe(false);
  });

  test("the request schema rejects controls and recognizable sensitive values in names", () => {
    for (const name of [
      "Customer\nsearch",
      "Customer\u202esearch",
      "Customer\u2066search",
      "Customer Bearer diag-secret-authorization-canary-74ab",
      "Customer token=diag-secret-assignment-canary",
      "Customer https://private.example.test/mcp?access_token=diag-secret-url-canary",
      "Customer /Users/diagnostics/private/connection.json",
      "Customer C:\\Users\\diagnostics\\private\\connection.json",
      "Customer ~/private/connection.json",
    ]) {
      const result = agentContextDiagnosticsRequestSchema.safeParse({
        organizationConnectionsProbe: {
          status: "observed",
          code: null,
          totalCount: 1,
          truncated: false,
        },
        organizationConnections: [{
          id: "externalMcpConnection_123",
          name,
          credentialMode: "per_member",
          connected: true,
          connectedForMe: true,
          needsReconnect: false,
          missingFeatureCount: 0,
        }],
      });
      expect(result.success).toBe(false);
    }
  });
});

describe("agent diagnostics workspace trust", () => {
  test("blocks explicit and legacy remote OpenCode while allowing local and remote OpenWork", () => {
    expect(isAgentContextDiagnosticsWorkspaceAllowed({
      workspaceType: "remote",
      remoteType: "opencode",
    })).toBe(false);
    expect(isAgentContextDiagnosticsWorkspaceAllowed({
      workspaceType: "remote",
      remoteType: "openwork",
    })).toBe(true);
    expect(isAgentContextDiagnosticsWorkspaceAllowed({
      workspaceType: "remote",
    })).toBe(false);
    expect(isAgentContextDiagnosticsWorkspaceAllowed({
      workspaceType: "remote",
      remoteType: null,
    })).toBe(false);
    expect(isAgentContextDiagnosticsWorkspaceAllowed({
      workspaceType: "local",
      remoteType: null,
    })).toBe(true);
    expect(isAgentContextDiagnosticsWorkspaceAllowed(null)).toBe(false);
  });
});
