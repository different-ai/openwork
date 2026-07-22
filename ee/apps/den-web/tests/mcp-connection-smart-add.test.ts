import { describe, expect, test } from "bun:test";

import {
  classifySmartAddInput,
  filterPresetSuggestions,
  planSmartAdd,
  smartAddAuthLabel,
} from "../app/(den)/dashboard/_components/mcp-connection-smart-add";
import type {
  ExternalMcpPreset,
  McpRequirementsDiscovery,
} from "../app/(den)/dashboard/_components/mcp-connections-data";

const PRESETS: ExternalMcpPreset[] = [
  { presetId: "notion", displayName: "Notion", description: "", url: "https://mcp.notion.com/mcp", authType: "oauth" },
  { presetId: "linear", displayName: "Linear", description: "", url: "https://mcp.linear.app/mcp", authType: "oauth" },
  { presetId: "slack", displayName: "Slack", description: "", url: "https://mcp.slack.com/mcp", authType: "oauth", requiresOAuthClient: true },
  { presetId: "sentry", displayName: "Sentry", description: "", url: "https://mcp.sentry.dev/mcp", authType: "oauth" },
  { presetId: "stripe", displayName: "Stripe", description: "", url: "https://mcp.stripe.com", authType: "oauth" },
];

function discovery(overrides: Partial<{
  status: McpRequirementsDiscovery["status"];
  kind: McpRequirementsDiscovery["authentication"]["kind"];
  issuers: string[];
  requiredScopes: string[];
  recommendedScopes: string[];
  manualRequirements: McpRequirementsDiscovery["manualRequirements"];
}> = {}): McpRequirementsDiscovery {
  return {
    status: overrides.status ?? "ready",
    server: { url: "https://mcp.example.com/mcp", initialize: "authentication_required" },
    authentication: {
      kind: overrides.kind ?? "oauth",
      authorizationServers: (overrides.issuers ?? ["https://auth.example.com"]).map((issuer) => ({
        issuer,
        clientIdMetadataDocumentSupported: true,
      })),
      requiredScopes: overrides.requiredScopes ?? [],
      recommendedScopes: overrides.recommendedScopes ?? [],
      refreshSupport: "supported",
      availableRegistrationMethods: ["client_metadata", "pre_registered"],
      recommendedRegistrationMethod: "client_metadata",
    },
    tools: { visibility: "requires_auth" },
    manualRequirements: overrides.manualRequirements ?? [],
    warnings: [],
  };
}

describe("classifySmartAddInput", () => {
  test("distinguishes URLs, domains, names, and noise", () => {
    expect(classifySmartAddInput("https://mcp.vercel.com/mcp")).toBe("url");
    expect(classifySmartAddInput("mcp.vercel.com")).toBe("domain");
    expect(classifySmartAddInput("vercel")).toBe("name");
    expect(classifySmartAddInput("Google Drive")).toBe("name");
    expect(classifySmartAddInput("")).toBe("empty");
    expect(classifySmartAddInput("   ")).toBe("empty");
    expect(classifySmartAddInput("https://user:pw@x.com/mcp")).toBe("invalid");
    expect(classifySmartAddInput("!!!")).toBe("invalid");
  });
});

describe("filterPresetSuggestions", () => {
  test("ranks prefix matches before substring matches and caps the list", () => {
    expect(filterPresetSuggestions(PRESETS, "s").length).toBe(0);
    const matches = filterPresetSuggestions(PRESETS, "se");
    expect(matches[0]?.presetId).toBe("sentry");
    expect(filterPresetSuggestions(PRESETS, "ear").map((preset) => preset.presetId)).toEqual(["linear"]);
    expect(filterPresetSuggestions(PRESETS, "st").length).toBeLessThanOrEqual(3);
  });

  test("matches a pasted URL to the preset with the same host", () => {
    expect(filterPresetSuggestions(PRESETS, "https://mcp.notion.com/mcp")[0]?.presetId).toBe("notion");
    expect(filterPresetSuggestions(PRESETS, "mcp.stripe.com")[0]?.presetId).toBe("stripe");
  });

  test("returns nothing for short or unmatched queries", () => {
    expect(filterPresetSuggestions(PRESETS, "v")).toEqual([]);
    expect(filterPresetSuggestions(PRESETS, "vercel")).toEqual([]);
  });
});

describe("planSmartAdd", () => {
  test("open servers are one click with a shared no-auth setup", () => {
    const plan = planSmartAdd(discovery({ status: "ready", kind: "none", issuers: [] }), { name: "Context7", url: "https://mcp.context7.com/mcp" });
    expect(plan.readiness).toBe("one_click");
    if (plan.readiness !== "one_click") throw new Error("expected one_click");
    expect(plan.input).toMatchObject({
      name: "Context7",
      url: "https://mcp.context7.com/mcp",
      authType: "none",
      credentialMode: "shared",
      access: { orgWide: true, memberIds: [], teamIds: [] },
    });
  });

  test("ready OAuth servers are one click with per-member sign-in and merged scopes", () => {
    const plan = planSmartAdd(
      discovery({ status: "ready", kind: "oauth", requiredScopes: ["read"], recommendedScopes: ["read", "offline_access"] }),
      { name: "Vercel", url: "https://mcp.vercel.com/mcp" },
    );
    expect(plan.readiness).toBe("one_click");
    if (plan.readiness !== "one_click") throw new Error("expected one_click");
    expect(plan.input.authType).toBe("oauth");
    expect(plan.input.credentialMode).toBe("per_member");
    expect(plan.input.authorizationServerIssuer).toBe("https://auth.example.com");
    expect(plan.input.requestedScopes).toEqual(["read", "offline_access"]);
  });

  test("manual requirements surface as blockers instead of a one-click add", () => {
    const plan = planSmartAdd(
      discovery({
        status: "manual_action_required",
        manualRequirements: [
          { code: "oauth_client_registration", label: "Register an OAuth client", reason: "", required: true },
          { code: "provider_access", label: "Provider access", reason: "", required: false },
        ],
      }),
      { name: "Slack", url: "https://mcp.slack.com/mcp" },
    );
    expect(plan.readiness).toBe("needs_details");
    if (plan.readiness !== "needs_details") throw new Error("expected needs_details");
    expect(plan.reasons).toEqual(["Register an OAuth client"]);
  });

  test("bearer-token servers ask for details and unreachable hosts are unsupported", () => {
    const bearer = planSmartAdd(
      discovery({ status: "manual_action_required", kind: "manual_bearer", issuers: [] }),
      { name: "Exa", url: "https://mcp.exa.ai/mcp" },
    );
    expect(bearer.readiness).toBe("needs_details");

    const unreachable = planSmartAdd(discovery({ status: "unreachable" }), { name: "X", url: "https://x.example" });
    expect(unreachable.readiness).toBe("unsupported");
  });
});

describe("smartAddAuthLabel", () => {
  test("labels each detected auth kind", () => {
    expect(smartAddAuthLabel(discovery({ kind: "none" }))).toBe("No sign-in needed");
    expect(smartAddAuthLabel(discovery({ kind: "oauth" }))).toBe("OAuth sign-in");
    expect(smartAddAuthLabel(discovery({ kind: "manual_bearer" }))).toBe("API key");
    expect(smartAddAuthLabel(discovery({ kind: "unknown" }))).toBe("Sign-in unclear");
  });
});
