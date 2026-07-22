import { describe, expect, test } from "bun:test";

import {
  agentContextAgentEvidenceSchema,
  agentContextDiagnosticCheckSchema,
  agentContextMcpEvidenceSchema,
  agentContextOrganizationConnectionSummarySchema,
  isAgentContextDiagnosticTextSafe as isSharedTextSafe,
  sanitizeAgentContextDiagnosticText as sanitizeSharedText,
} from "@openwork/types/agent-context-diagnostics";
import {
  agentContextDiagnosticCheckRuntimeSchema,
  isAgentContextDiagnosticTextSafe as isLocalTextSafe,
  sanitizeAgentContextDiagnosticText as sanitizeLocalText,
} from "./agent-context-diagnostics-schema.js";

const forbiddenCharacters = [
  "\u0000",
  "\u0085",
  "\u00ad",
  "\u061c",
  "\u200b",
  "\u200e",
  "\u202e",
  "\u2060",
  "\u2066",
  "\ufe0f",
];
const sensitiveDynamicLabels = [
  "Customer docs Bearer diag-secret-authorization-canary-74ab",
  "Customer docs Bearer q",
  "Customer docs Bearer token",
  "Customer docs Be ar er split-secret",
  "Customer docs B/e.a-r_er punctuation-split-secret",
  "Customer docs B/\u200be.a-r_er combined-split-secret",
  "Customer docs B\u200bearer zero-width-secret",
  "Customer docs Be%E2%80%8Barer%20encoded-zero-width-secret",
  "Customer docs Be%E2%80%8Barer%20encoded-secret%ZZ",
  "Customer docs Bearer%E2%20malformed-prefix-secret",
  "Customer docs %42earer%20percent-secret",
  "Customer docs %2542earer%2520double-percent-secret",
  "Customer docs %2525252542earer%2525252520diag-secret-canary",
  "Customer docs Ｂｅａｒｅｒ fullwidth-secret",
  "Customer docs authorization=Basic-ZGlhZ25vc3RpY3M=",
  "Customer docs client_secret=diag-secret-assignment-canary",
  "Customer docs cli ent _ sec ret = q",
  "Customer docs cli/*ent_se-cret=q",
  "Customer docs cli/%E2%80%8Bent_se-cret=q",
  "Customer docs client%5Fsecret%3Dq",
  "Customer docs to ken = z",
  "Customer docs to❄ken=z",
  "Customer docs %74%6f%6b%65%6e%3dq",
  "Customer docs https://private.example.test/mcp?access_token=diag-secret-url-canary",
  "Customer docs https%3A%2F%2Fprivate.example.test%2Fmcp%3Ftoken%3Dq",
  "Customer docs https: //private.example.test/private-catalog",
  "Customer docs /Users/diagnostics/private/connection.json",
  "Customer docs %2FUsers%2Fdiagnostics%2Fprivate%2Fconnection.json",
  "Customer docs %2Fmcp%2Fagent",
  "Customer docs ／mcp／agent",
  "Customer docs C:\\Users\\diagnostics\\private\\connection.json",
  "Customer docs ~/private/connection.json",
  "Customer docs eyJhbGciOiJIUzI1NiJ9.cHJpdmF0ZS1kaWFnbm9zdGljcw.c2lnbmF0dXJlLWNhbmFyeQ",
  "Customer docs eyJx.e30.x",
  "Customer docs owt_diag_secret_token_canary",
  "Customer docs owt_a",
  "Customer docs ow_mcp_at_ZGlhZ25vc3RpY3MtYmVhcmVy",
  "Customer docs sk-a",
  "Customer docs ghp_a",
  "Customer docs xoxb-a",
];

describe("agent context diagnostics safe output schema", () => {
  test("rejects control and bidirectional characters in check text and detail keys", () => {
    const base = {
      id: "request-safety" as const,
      status: "passed" as const,
      evidenceKind: "derived" as const,
      code: "safe_code",
      message: "Safe message",
      owner: "openwork-server" as const,
      action: "No action is required.",
      details: { safeKey: "safe value" },
      durationMs: 0,
    };

    const schemas = [agentContextDiagnosticCheckSchema, agentContextDiagnosticCheckRuntimeSchema];
    for (const schema of schemas) expect(schema.safeParse(base).success).toBe(true);
    for (const character of forbiddenCharacters) {
      for (const schema of schemas) {
        expect(schema.safeParse({ ...base, code: `unsafe${character}code` }).success).toBe(false);
        expect(schema.safeParse({ ...base, message: `unsafe${character}message` }).success).toBe(false);
        expect(schema.safeParse({ ...base, action: `unsafe${character}action` }).success).toBe(false);
        expect(schema.safeParse({
          ...base,
          details: { [`unsafe${character}key`]: "safe value" },
        }).success).toBe(false);
      }
    }
  });

  test("rejects unsafe dynamic agent, MCP, and organization labels", () => {
    const agent = {
      evidenceSource: "configured-intent" as const,
      defaultAgent: "openwork",
      configuredOpenworkAgent: {
        state: "present" as const,
        mode: "primary" as const,
        prompt: {
          length: 0,
          sha256: null,
          markers: { searchCapabilities: true, executeCapability: true, memoryBank: true },
        },
        connectToolPermissions: {
          searchCapabilities: "unspecified" as const,
          executeCapability: "unspecified" as const,
          deniedRelevantToolCount: null,
        },
      },
      pluginLabels: ["openwork-extensions-preview"],
    };
    const mcp = {
      name: "openwork-cloud",
      source: "config.remote" as const,
      type: "remote" as const,
      enabled: true,
      disabledByTools: false,
      origin: null,
      path: "/mcp/agent",
      hasHeaders: true,
      oauthMode: "disabled" as const,
      syncStatus: "connected" as const,
      liveEngineStatus: "unavailable" as const,
    };
    const organization = {
      id: "connection.safe",
      name: "Safe connection",
      credentialMode: "per_member" as const,
      connected: true,
      connectedForMe: true,
      needsReconnect: false,
      missingFeatureCount: 0,
    };

    expect(agentContextMcpEvidenceSchema.safeParse(mcp).success).toBe(true);
    expect(agentContextMcpEvidenceSchema.safeParse({
      ...mcp,
      path: "/deployment-prefix/mcp/agent",
    }).success).toBe(false);

    for (const character of forbiddenCharacters) {
      expect(agentContextAgentEvidenceSchema.safeParse({
        ...agent,
        defaultAgent: `unsafe${character}agent`,
      }).success).toBe(false);
      expect(agentContextAgentEvidenceSchema.safeParse({
        ...agent,
        pluginLabels: [`unsafe${character}plugin`],
      }).success).toBe(false);
      expect(agentContextMcpEvidenceSchema.safeParse({ ...mcp, name: `unsafe${character}mcp` }).success).toBe(false);
      expect(agentContextMcpEvidenceSchema.safeParse({ ...mcp, path: `/unsafe${character}/mcp/agent` }).success).toBe(false);
      expect(agentContextOrganizationConnectionSummarySchema.safeParse({
        ...organization,
        name: `unsafe${character}connection`,
      }).success).toBe(false);
    }

    for (const value of sensitiveDynamicLabels) {
      expect({ value, safe: isSharedTextSafe(value) }).toEqual({ value, safe: false });
      expect({ value, safe: isLocalTextSafe(value) }).toEqual({ value, safe: false });
      const sharedSanitized = sanitizeSharedText(value);
      const localSanitized = sanitizeLocalText(value);
      expect(localSanitized).toBe(sharedSanitized);
      expect(isSharedTextSafe(sharedSanitized)).toBe(true);
      expect(isLocalTextSafe(localSanitized)).toBe(true);
      expect(agentContextDiagnosticCheckSchema.safeParse({ ...baseCheck(), message: value }).success).toBe(false);
      expect(agentContextDiagnosticCheckRuntimeSchema.safeParse({ ...baseCheck(), details: { dynamicLabel: value } }).success).toBe(false);
      expect(agentContextAgentEvidenceSchema.safeParse({ ...agent, pluginLabels: [value] }).success).toBe(false);
      expect(agentContextMcpEvidenceSchema.safeParse({ ...mcp, name: value }).success).toBe(false);
      expect(agentContextOrganizationConnectionSummarySchema.safeParse({ ...organization, name: value }).success).toBe(false);
    }

    expect(isSharedTextSafe("Route /mcp/agent is intentionally allowlisted.")).toBe(true);
    expect(isLocalTextSafe("Route /mcp/agent is intentionally allowlisted.")).toBe(true);
    expect(sanitizeSharedText("Route /mcp/agent is intentionally allowlisted.")).toBe(
      "Route /mcp/agent is intentionally allowlisted.",
    );
    expect(sanitizeLocalText("Route /mcp/agent is intentionally allowlisted.")).toBe(
      "Route /mcp/agent is intentionally allowlisted.",
    );
    expect(isSharedTextSafe("The configuration requires one managed authentication value.")).toBe(true);
    expect(isLocalTextSafe("The configuration requires one managed authentication value.")).toBe(true);
    expect(isSharedTextSafe("The configuration requires one bearer credential.")).toBe(false);
    expect(isLocalTextSafe("The configuration requires one bearer credential.")).toBe(false);
    expect(isSharedTextSafe("Customer%20docs")).toBe(true);
    expect(isLocalTextSafe("Customer%20docs")).toBe(true);
  });

  test("fails closed when controls are used to obscure a sensitive label", () => {
    for (const value of [
      "Customer Bearer\ndiag-secret-control-canary",
      "Customer Bearer\u202ediag-secret-control-canary",
      "Customer to\u202eken=diag-secret-control-canary",
      "Customer https:\u202e//private.example.test/catalog",
      "Customer C:\u202e\\Users\\diagnostics\\private\\report.json",
      "Customer B\u200bearer q",
      "Customer cli\u2060ent_secret=q",
    ]) {
      expect(sanitizeSharedText(value)).toBe("[redacted-sensitive-label]");
      expect(sanitizeLocalText(value)).toBe("[redacted-sensitive-label]");
      expect(isSharedTextSafe(value)).toBe(false);
      expect(isLocalTextSafe(value)).toBe(false);
    }
  });

  test("fails closed when percent encoding exceeds the normalization budget", () => {
    let deeplyNestedCredential = "%42earer%20deep-percent-secret";
    for (let round = 0; round < 16; round += 1) {
      deeplyNestedCredential = encodeURIComponent(deeplyNestedCredential);
    }

    expect(sanitizeSharedText(deeplyNestedCredential)).toBe("[redacted-sensitive-label]");
    expect(sanitizeLocalText(deeplyNestedCredential)).toBe("[redacted-sensitive-label]");
    expect(isSharedTextSafe(deeplyNestedCredential)).toBe(false);
    expect(isLocalTextSafe(deeplyNestedCredential)).toBe(false);
  });
});

function baseCheck() {
  return {
    id: "request-safety" as const,
    status: "passed" as const,
    evidenceKind: "derived" as const,
    code: "safe_code",
    message: "Safe message",
    owner: "openwork-server" as const,
    action: "No action is required.",
    details: { safeKey: "safe value" },
    durationMs: 0,
  };
}
