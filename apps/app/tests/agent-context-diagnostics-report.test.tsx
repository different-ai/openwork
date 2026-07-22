/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AGENT_CONTEXT_DIAGNOSTIC_CHECK_IDS,
  agentContextDiagnosticsReportSchema,
  type AgentContextDiagnosticCheck,
  type AgentContextDiagnosticsReport,
} from "@openwork/types/agent-context-diagnostics";

import { serializeAgentContextDiagnosticsReport } from "../src/app/lib/agent-context-diagnostics";
import {
  AgentContextDiagnosticsErrorNotice,
  AgentContextDiagnosticsReportView,
  organizationConnectionState,
} from "../src/react-app/domains/settings/pages/agent-context-diagnostics-report";

function healthyReport(): AgentContextDiagnosticsReport {
  const passiveEngineCheckIds = new Set([
    "agent-connect-tool-permissions",
    "engine-config",
    "engine-agent",
    "engine-plugin-tools",
    "engine-mcp-status",
    "cloud-tool-catalog",
  ]);
  const checks: AgentContextDiagnosticCheck[] = AGENT_CONTEXT_DIAGNOSTIC_CHECK_IDS.map((id) => ({
    id,
    status: passiveEngineCheckIds.has(id) ? "warning" : "passed",
    evidenceKind: passiveEngineCheckIds.has(id)
      ? "unavailable"
      : id === "request-safety"
      ? "expected"
      : id === "cloud-tool-catalog"
        ? "observed"
        : id === "organization-connections"
          ? "client-observed"
        : "observed",
    code: passiveEngineCheckIds.has(id) ? `${id}-not-queried` : `${id}-ok`,
    message: passiveEngineCheckIds.has(id) ? `${id} intentionally not queried.` : `${id} verified.`,
    owner: "openwork-server",
    action: "No action required.",
    details: id === "cloud-tool-catalog"
      ? {
          expectedToolIds: ["search_capabilities", "execute_capability"],
          observedToolIds: ["search_capabilities", "execute_capability"],
        }
      : {},
    durationMs: 1,
  }));

  return {
    schemaVersion: 1,
    runId: "22222222-2222-4222-8222-222222222222",
    startedAt: "2026-07-13T20:00:00.000Z",
    completedAt: "2026-07-13T20:00:00.125Z",
    durationMs: 125,
    overall: "warning",
    firstFailedCheck: null,
    workspace: {
      id: "workspace_test",
      name: "Customer workspace",
      type: "local",
      remoteType: null,
      engineConfigured: true,
    },
    checks,
    agent: {
      evidenceSource: "configured-intent",
      defaultAgent: "openwork",
      configuredOpenworkAgent: {
        state: "present",
        mode: "primary",
        prompt: {
          length: 1_024,
          sha256: "a".repeat(64),
          markers: {
            searchCapabilities: true,
            executeCapability: true,
            memoryBank: true,
          },
        },
        connectToolPermissions: {
          searchCapabilities: "unspecified",
          executeCapability: "unspecified",
          deniedRelevantToolCount: null,
        },
      },
      pluginLabels: ["openwork-extensions-preview", "openwork-capabilities-knowledge"],
    },
    mcps: [
      {
        name: "openwork-cloud",
        source: "config.global",
        type: "remote",
        enabled: true,
        disabledByTools: false,
        origin: null,
        path: null,
        hasHeaders: false,
        oauthMode: "none",
        syncStatus: "not-applicable",
        liveEngineStatus: "unavailable",
      },
      {
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
      },
    ],
    connect: {
      connectEnabled: true,
      legacyGoogleWorkspaceConfigured: false,
      expectedBranch: "cloud-active",
      globalCloudMcpPresent: true,
      selectedWorkspaceCloudMcpPresent: true,
      crossWorkspaceSteeringDrift: false,
    },
    observedCloudToolIds: [],
    organizationConnectionsProbe: { status: "observed", code: null, totalCount: 1, truncated: false },
    organizationConnections: [{
      id: "externalMcpConnection_test",
      name: "Customer search",
      credentialMode: "shared",
      connected: true,
      connectedForMe: true,
      needsReconnect: false,
      missingFeatureCount: 0,
    }],
    safety: {
      diagnosticsWorkspaceRuntimeConfigurationReadOnly: true,
      cloudCatalogToolsListPerformed: false,
      directNonCloudMcpFetchPerformed: false,
      directMcpToolCallPerformed: false,
      directProviderOperationPerformed: false,
      directConfigurationMutationPerformed: false,
      directEphemeralCredentialMintPerformed: false,
      engineApiReadPerformed: false,
      engineBootstrapMayHaveRun: false,
      engineBootstrapSideEffectsInspected: false,
      authSessionActivityMayBeRecorded: true,
      tokenValuesIncluded: false,
      authorizationHeaderValuesIncluded: false,
      credentialValuesIncluded: false,
      rawPromptsIncluded: false,
      providerResponsesIncluded: false,
      stackTracesIncluded: false,
      rawEngineErrorsIncluded: false,
      secretBearingUrlsIncluded: false,
      inputStrictlyValidated: true,
    },
  };
}

describe("AgentContextDiagnosticsReportView", () => {
  test("renders the detailed observed-versus-expected report with stable proof labels", () => {
    const html = renderToStaticMarkup(
      <AgentContextDiagnosticsReportView report={healthyReport()} copied={false} copying={false} onCopy={() => {}} />,
    );

    expect(html).toContain("Agent diagnostics report");
    expect(html).toContain("22222222-2222-4222-8222-222222222222");
    expect(html).toContain("Expected");
    expect(html).toContain("Client observed");
    expect(html).toContain("Observed");
    expect(html).toContain("openwork-extensions-preview");
    expect(html).toContain("config.remote");
    expect(html).toContain("Registration record: Connected");
    expect(html).toContain("Configured default-agent intent");
    expect(html).toContain("Configured OpenWork agent");
    expect(html).toContain("Configured enabled");
    expect(html).toContain("Configured headers present · values redacted");
    expect(html).toContain("Live connection status not queried");
    expect(html).toContain("No LLM turn is started");
    expect(html).toContain("/mcp/agent");
    expect(html).not.toContain("/wrong-layer/mcp/agent");
    expect(html).toContain("search_capabilities");
    expect(html).toContain("execute_capability");
    expect(html).toContain("Customer search");
    expect(html).toContain("No action required.");
    expect(html).toContain('data-testid="agent-diagnostics-copy"');
    expect(html).toContain('data-testid="agent-diagnostics-report"');
    expect(html).toContain('data-testid="agent-diagnostics-completion-status"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-atomic="true"');
    expect(html).toContain("Agent diagnostics complete: Warning");
    expect(html).toContain('aria-label="search_capabilities: Yes"');
    expect(html).toContain('data-marker-value="true"');
    expect(html).toContain('data-testid="agent-diagnostics-cloud-endpoint"');
    expect(html).toContain('data-testid="agent-diagnostics-mcp-sync"');
    expect(html).toContain('data-testid="agent-diagnostics-plugin-tools-unavailable"');
    expect(html).not.toContain("Settings Connect marker");
    expect(html.match(/data-testid="agent-diagnostics-check"/g)).toHaveLength(
      AGENT_CONTEXT_DIAGNOSTIC_CHECK_IDS.length,
    );
  });

  test("announces false context markers and diagnostic errors without relying on color", () => {
    const report = healthyReport();
    report.agent.configuredOpenworkAgent.prompt.markers.memoryBank = false;
    const reportHtml = renderToStaticMarkup(
      <AgentContextDiagnosticsReportView report={report} copied={false} copying={false} onCopy={() => {}} />,
    );
    const errorHtml = renderToStaticMarkup(
      <AgentContextDiagnosticsErrorNotice message="Agent diagnostics could not complete." />,
    );

    expect(reportHtml).toContain('aria-label="Memory marker: No"');
    expect(reportHtml).toContain('data-marker-value="false"');
    expect(errorHtml).toContain('data-testid="agent-diagnostics-error"');
    expect(errorHtml).toContain('role="alert"');
    expect(errorHtml).toContain('aria-live="assertive"');
    expect(errorHtml).toContain('aria-atomic="true"');
    expect(errorHtml).toContain("Agent diagnostics could not complete.");
  });

  test("labels engine-resolved evidence as effective and tool-policy-disabled MCPs as disabled", () => {
    const report = healthyReport();
    const engineConfigCheck = report.checks.find((check) => check.id === "engine-config");
    if (!engineConfigCheck) throw new Error("Expected engine-config check fixture.");
    engineConfigCheck.status = "passed";
    engineConfigCheck.evidenceKind = "observed";
    report.agent.evidenceSource = "effective-engine";
    report.safety.engineApiReadPerformed = true;
    report.safety.engineBootstrapMayHaveRun = true;
    report.mcps[0] = { ...report.mcps[0], source: "engine.config", disabledByTools: true };

    const html = renderToStaticMarkup(
      <AgentContextDiagnosticsReportView report={report} copied={false} copying={false} onCopy={() => {}} />,
    );

    expect(html).toContain("Effective default agent");
    expect(html).toContain("Effective OpenWork agent");
    expect(html).toContain("Effective plugin labels");
    expect(html).toContain("Effective configuration observed");
    expect(html).toContain("Disabled by tool policy");
    expect(html).not.toContain("Effective engine configuration (not queried)");
  });

  test("renders and serializes an effective ask rule as approval required", () => {
    const report = healthyReport();
    report.agent.configuredOpenworkAgent.connectToolPermissions.searchCapabilities = "approval-required";

    const html = renderToStaticMarkup(
      <AgentContextDiagnosticsReportView report={report} copied={false} copying={false} onCopy={() => {}} />,
    );
    const serialized = serializeAgentContextDiagnosticsReport(report);

    expect(html).toContain("search_capabilities permission");
    expect(html).toContain("Approval required");
    expect(serialized).toContain('"searchCapabilities": "approval-required"');
    expect(agentContextDiagnosticsReportSchema.safeParse(JSON.parse(serialized)).success).toBe(true);
  });

  test("disables Copy report while copying and exposes a polite success announcement", () => {
    const html = renderToStaticMarkup(
      <AgentContextDiagnosticsReportView report={healthyReport()} copied copying onCopy={() => {}} />,
    );

    expect(html).toContain('data-testid="agent-diagnostics-copy"');
    expect(html).toContain('disabled=""');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('data-testid="agent-diagnostics-copy-status"');
    expect(html).toContain("Sanitized agent diagnostics report copied.");
  });

  test("serializes only the strict sanitized report contract", () => {
    const serialized = serializeAgentContextDiagnosticsReport(healthyReport());
    expect(serialized).toContain('"diagnosticsWorkspaceRuntimeConfigurationReadOnly": true');
    expect(serialized).toContain('"directProviderOperationPerformed": false');
    expect(serialized).toContain('"authSessionActivityMayBeRecorded": true');
    expect(serialized).toContain('"directEphemeralCredentialMintPerformed": false');
    expect(serialized).toContain('"engineApiReadPerformed": false');
    expect(serialized).toContain('"tokenValuesIncluded": false');
    expect(serialized).not.toContain("Authorization: Bearer");
    expect(serialized).not.toContain("raw prompt text");
    expect(serialized).not.toContain("provider response body");
    expect(serialized).not.toContain("stack trace");
  });

  test("does not label an organization connection ready when features are missing", () => {
    const connection = healthyReport().organizationConnections[0];
    if (!connection) throw new Error("Expected an organization connection fixture.");
    const state = organizationConnectionState({
      ...connection,
      credentialMode: "per_member",
      connectedForMe: true,
      needsReconnect: false,
      missingFeatureCount: 1,
    });

    expect(state.status).toBe("warning");
    expect(state.label).toBe("Needs reconnect");
  });

  test("rejects duplicate observed cloud tool IDs", () => {
    const report = {
      ...healthyReport(),
      observedCloudToolIds: ["search_capabilities", "search_capabilities"],
    };
    expect(agentContextDiagnosticsReportSchema.safeParse(report).success).toBe(false);
  });

  test("rejects claims that passive diagnostics queried live engine state", () => {
    const report = healthyReport();
    report.mcps[0] = { ...report.mcps[0], liveEngineStatus: "connected" };
    expect(agentContextDiagnosticsReportSchema.safeParse(report).success).toBe(false);
  });

  test("rejects control and bidirectional formatting anywhere in copied report labels", () => {
    for (const name of ["Workspace\nname", "Workspace\u061cname", "Workspace\u200fname", "Workspace\u202ename"]) {
      const report = healthyReport();
      report.workspace.name = name;
      expect(agentContextDiagnosticsReportSchema.safeParse(report).success).toBe(false);
    }
  });

  test("rejects credential-bearing URLs and absolute paths in copied dynamic labels", () => {
    const unsafeValues = [
      "Workspace Bearer copied-report-secret",
      "Workspace client_secret=copied-report-secret",
      "Workspace https://private.example.test/mcp?token=copied-report-secret",
      "Workspace /Users/diagnostics/private/report.json",
      "Workspace C:\\Users\\diagnostics\\private\\report.json",
      "Workspace ~/private/report.json",
    ];
    for (const name of unsafeValues) {
      const report = healthyReport();
      report.workspace.name = name;
      expect(agentContextDiagnosticsReportSchema.safeParse(report).success).toBe(false);
      expect(() => serializeAgentContextDiagnosticsReport(report)).toThrow();
    }
  });

  test("rejects contradictory summary, organization, and cloud observations", () => {
    const wrongOverall = { ...healthyReport(), overall: "passed" };
    expect(agentContextDiagnosticsReportSchema.safeParse(wrongOverall).success).toBe(false);

    const staleOrganizationRows = {
      ...healthyReport(),
      organizationConnectionsProbe: {
        status: "skipped",
        code: "signed_out",
        totalCount: 0,
        truncated: false,
      },
    };
    expect(agentContextDiagnosticsReportSchema.safeParse(staleOrganizationRows).success).toBe(false);

    const toolsWithoutProbe = {
      ...healthyReport(),
      observedCloudToolIds: ["search_capabilities"],
    };
    expect(agentContextDiagnosticsReportSchema.safeParse(toolsWithoutProbe).success).toBe(false);

    const cloudProbeWithoutEffectivePolicy = {
      ...healthyReport(),
      safety: { ...healthyReport().safety, cloudCatalogToolsListPerformed: true },
    };
    expect(agentContextDiagnosticsReportSchema.safeParse(cloudProbeWithoutEffectivePolicy).success).toBe(false);

    const effectiveEvidenceWithoutEngineRead = {
      ...healthyReport(),
      agent: { ...healthyReport().agent, evidenceSource: "effective-engine" },
    };
    expect(agentContextDiagnosticsReportSchema.safeParse(effectiveEvidenceWithoutEngineRead).success).toBe(false);
  });

  test("does not export the obsolete client cloud-catalog probe contract", async () => {
    const contract = await import("@openwork/types/agent-context-diagnostics");
    expect("agentContextCloudCatalogProbeSchema" in contract).toBe(false);
    expect("agentContextCloudCatalogProbeCodeSchema" in contract).toBe(false);
  });
});
