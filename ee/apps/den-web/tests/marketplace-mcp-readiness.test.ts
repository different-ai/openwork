import { describe, expect, test } from "bun:test";

import { formatRequiredBy, sortConnectionsForFocus, trustedConnectionFocusId } from "../app/(den)/dashboard/_components/mcp-connection-display";
import { marketplaceConnectionNeedsAdminSetup } from "../app/(den)/dashboard/_components/mcp-connection-setup";
import type { ExternalMcpConnection, ExternalMcpPreset, ExternalMcpRequiredBy } from "../app/(den)/dashboard/_components/mcp-connections-data";
import { parseMarketplaceResolvedPayload, type MarketplacePluginCloudReadinessConnection } from "../app/(den)/dashboard/_components/marketplace-data";
import {
  findPresetForRequirement,
  pluginReadinessConnectionAction,
  pluginRequirementNeedsAdminSetup,
  pluginSetupAuthType,
  pluginSetupCredentialMode,
  pluginSetupInitialState,
  pluginSetupRequest,
  pluginSetupSuccessCopy,
} from "../app/(den)/dashboard/_components/marketplace-mcp-setup";

function connection(input: { id: string; name: string; requiredBy?: ExternalMcpRequiredBy[] }): ExternalMcpConnection {
  return {
    id: input.id,
    name: input.name,
    url: "https://mcp.slack.com/mcp",
    authType: "oauth",
    credentialMode: "per_member",
    connected: true,
    connectedAt: null,
    connectedForMe: false,
    requiredBy: input.requiredBy ?? [],
    identityManagedBy: [],
    access: null,
  };
}

function requirement(url: string): MarketplacePluginCloudReadinessConnection {
  return {
    configObjectId: "cfg_remote",
    id: null,
    name: "remote",
    serverName: "remote",
    url,
  };
}

describe("marketplace MCP readiness parsing", () => {
  test("preserves cloud readiness connection provenance fields", () => {
    const parsed = parseMarketplaceResolvedPayload({
      item: {
        marketplace: {
          id: "mkp_support",
          name: "Team Marketplace",
          description: null,
          logoUrl: null,
          pluginCount: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        plugins: [{
          id: "plg_support",
          name: "Support Operations",
          description: "Support flow",
          memberCount: 1,
          componentCounts: { mcp: 1 },
          extension: { sourceFormat: "claude-plugin" },
          cloudReadiness: {
            state: "needs_admin_setup",
            hasInstructional: true,
            connections: [{
              authType: "oauth",
              authTypeMismatch: false,
              configObjectId: "cfg_slack",
              id: null,
              name: "slack",
              serverName: "slack",
              url: "https://mcp.slack.com/mcp",
              oauthClientConfigured: false,
              oauthClientRequired: true,
              requiredAuthType: "oauth",
            }],
          },
        }],
        source: null,
      },
    });

    expect(parsed.plugins[0]?.cloudReadiness?.connections[0]).toEqual({
      authType: "oauth",
      authTypeMismatch: false,
      configObjectId: "cfg_slack",
      id: null,
      name: "slack",
      serverName: "slack",
      url: "https://mcp.slack.com/mcp",
      oauthClientConfigured: false,
      oauthClientRequired: true,
      requiredAuthType: "oauth",
    });
  });

  test("matches preset auth without asking for plugin URL input", () => {
    const presets: ExternalMcpPreset[] = [
      { presetId: "slack", displayName: "Slack", description: "Slack", url: "https://mcp.slack.com/mcp", authType: "oauth", requiresOAuthClient: true },
      { presetId: "exa", displayName: "Exa", description: "Search", url: "https://mcp.exa.ai/mcp", authType: "apikey" },
      { presetId: "context7", displayName: "Context7", description: "Docs", url: "https://mcp.context7.com/mcp", authType: "none" },
    ];
    const context7 = {
      configObjectId: "cfg_docs",
      id: null,
      name: "context7",
      serverName: "context7",
      url: "https://mcp.context7.com/mcp/",
    };
    const exa = {
      configObjectId: "cfg_search",
      id: null,
      name: "exa",
      serverName: "exa",
      url: "https://mcp.exa.ai/mcp",
    };

    expect(findPresetForRequirement(presets, context7)?.displayName).toBe("Context7");
    expect(pluginSetupAuthType(findPresetForRequirement(presets, context7))).toBe("none");
    expect(pluginSetupAuthType(findPresetForRequirement(presets, exa))).toBe("apikey");
    expect(pluginSetupInitialState(findPresetForRequirement(presets, exa))).toMatchObject({ authAssumed: false, authType: "apikey", credentialMode: "shared" });
  });

  test("matches presets without erasing path case or query parameters", () => {
    const presets: ExternalMcpPreset[] = [{
      presetId: "tenant-a",
      displayName: "Tenant A",
      description: "Tenant-scoped server",
      url: "https://MCP.EXAMPLE.com:443/MCP/?tenant=a",
      authType: "oauth",
    }];

    expect(findPresetForRequirement(presets, requirement("https://mcp.example.com/MCP?tenant=a"))?.presetId).toBe("tenant-a");
    expect(findPresetForRequirement(presets, requirement("https://mcp.example.com/MCP?tenant=b"))).toBeNull();
    expect(findPresetForRequirement(presets, requirement("https://mcp.example.com/mcp?tenant=a"))).toBeNull();
    expect(findPresetForRequirement(presets, requirement("https://user:secret@mcp.example.com/MCP?tenant=a"))).toBeNull();
    expect(findPresetForRequirement(presets, requirement("https://mcp.example.com/MCP?tenant=a#fragment"))).toBeNull();
  });

  test("builds Exa API-key setup as organization-shared without exposing the secret in output", () => {
    const secret = "local-test-api-key";
    const request = pluginSetupRequest({ authType: "apikey", credentialMode: "per_member", apiKey: secret });
    const redacted = { ...request, apiKey: request.apiKey ? "<redacted>" : undefined };

    expect(request.authType).toBe("apikey");
    expect(request.credentialMode).toBe("shared");
    expect(typeof request.apiKey).toBe("string");
    expect(JSON.stringify(redacted)).not.toContain(secret);
  });

  test("unknown plugin MCP setup defaults OAuth explicitly and remains editable", () => {
    const initial = pluginSetupInitialState(null);

    expect(initial).toEqual({ authAssumed: true, authType: "oauth", credentialMode: "per_member" });
    expect(pluginSetupCredentialMode("apikey", "per_member")).toBe("shared");
    expect(pluginSetupCredentialMode("none", "per_member")).toBe("shared");
    expect(pluginSetupCredentialMode("oauth", "shared")).toBe("shared");
  });

  test("success copy matches the credential state", () => {
    const perMember = pluginSetupSuccessCopy({ authType: "oauth", credentialMode: "per_member", pluginName: "Support Operations", serviceName: "Slack" });
    const shared = pluginSetupSuccessCopy({ authType: "oauth", credentialMode: "shared", pluginName: "Support Operations", serviceName: "Slack" });
    const apiKey = pluginSetupSuccessCopy({ authType: "apikey", credentialMode: "shared", pluginName: "Search Ops", serviceName: "Exa" });
    const noAuth = pluginSetupSuccessCopy({ authType: "none", credentialMode: "shared", pluginName: "Docs Ops", serviceName: "Context7" });

    expect(perMember.body).toContain("Assigned users connect their own account");
    expect(perMember.linkLabel).toBe("Open Your Connections");
    expect(shared.body).toContain("Connect the organization account");
    expect(shared.linkLabel).toBe("Connect organization account");
    expect(apiKey.body).toContain("ready");
    expect(apiKey.linkLabel).toBeNull();
    expect(noAuth.body).toContain("No user sign-in is needed");
    expect(noAuth.linkLabel).toBeNull();
  });

  test("projects existing shared disconnected requirements as admin connect actions", () => {
    const requirement: MarketplacePluginCloudReadinessConnection = {
      configObjectId: "cfg_slack",
      id: "emc_shared_slack",
      name: "Support Operations / slack",
      serverName: "slack",
      url: "https://mcp.slack.com/mcp",
      credentialMode: "shared",
      connectedForMe: false,
    };

    expect(pluginReadinessConnectionAction(requirement, true)).toEqual({
      connectionId: "emc_shared_slack",
      label: "Connect organization account",
      note: "An admin connects one organization account from Your Connections. OAuth starts only after an admin clicks Connect there.",
      type: "connect_org",
    });
    expect(pluginReadinessConnectionAction(requirement, false)).toBeNull();
  });

  test("keeps imported OAuth requirements in admin setup until their required client exists", () => {
    const requirement: MarketplacePluginCloudReadinessConnection = {
      authType: "oauth",
      configObjectId: "cfg_slack",
      id: "emc_shared_slack",
      name: "Support Operations / slack",
      serverName: "slack",
      url: "https://mcp.slack.com/mcp",
      credentialMode: "per_member",
      connectedForMe: false,
      oauthClientConfigured: false,
      oauthClientRequired: true,
    };

    expect(pluginRequirementNeedsAdminSetup(requirement)).toBe(true);
    expect(pluginRequirementNeedsAdminSetup({ ...requirement, oauthClientConfigured: true })).toBe(false);
    expect(pluginRequirementNeedsAdminSetup({
      ...requirement,
      authType: "none",
      authTypeMismatch: true,
      oauthClientConfigured: true,
      requiredAuthType: "oauth",
    })).toBe(true);
  });

  test("projects existing per-member disconnected requirements as Your Connections handoffs", () => {
    const requirement: MarketplacePluginCloudReadinessConnection = {
      configObjectId: "cfg_slack",
      id: "emc_member_slack",
      name: "Support Operations / slack",
      serverName: "slack",
      url: "https://mcp.slack.com/mcp",
      credentialMode: "per_member",
      connectedForMe: false,
    };

    expect(pluginReadinessConnectionAction(requirement, true)).toEqual({
      connectionId: "emc_member_slack",
      label: "Open Your Connections",
      note: "Assigned members connect individually from Your Connections. This link only focuses the connection; it will not start OAuth.",
      type: "connect_member",
    });
    expect(pluginReadinessConnectionAction(requirement, false)).toEqual({
      connectionId: "emc_member_slack",
      label: "Connect your account",
      note: "Connect your own account from Your Connections. OAuth starts only after you click Connect there.",
      type: "connect_member",
    });
  });
});

describe("Your Connections focus and provenance helpers", () => {
  test("blocks member OAuth until an admin repairs a marketplace-managed Slack connection", () => {
    const slackPreset: ExternalMcpPreset = {
      presetId: "slack",
      displayName: "Slack",
      description: "Slack",
      url: "https://mcp.slack.com/mcp",
      authType: "oauth",
      requiresOAuthClient: true,
    };
    const imported = connection({ id: "emc_slack", name: "Anthropic Engineering / slack" });
    imported.authType = "none";
    imported.connected = true;
    imported.identityManagedBy = [{ pluginId: "plg_engineering", name: "Anthropic Engineering" }];
    imported.requiredAuthType = "oauth";
    imported.authTypeMismatch = true;
    imported.setupRequired = true;

    expect(marketplaceConnectionNeedsAdminSetup(imported, [slackPreset])).toBe(true);
    expect(marketplaceConnectionNeedsAdminSetup({
      ...imported,
      authType: "oauth",
      connected: false,
      oauthClientConfigured: true,
      authTypeMismatch: false,
      setupRequired: false,
    }, [slackPreset])).toBe(false);
  });

  test("focuses only authorized returned connection ids", () => {
    const connections = [
      connection({ id: "emc_one", name: "Support Operations / slack" }),
      connection({ id: "emc_two", name: "Sales Operations / slack" }),
    ];

    expect(trustedConnectionFocusId(connections, "emc_two")).toBe("emc_two");
    expect(trustedConnectionFocusId(connections, "emc_missing")).toBeNull();
    expect(sortConnectionsForFocus(connections, "emc_two").map((entry) => entry.id)).toEqual(["emc_two", "emc_one"]);
  });

  test("renders collision provenance without collapsing rows by provider name", () => {
    const sharedSlack = connection({
      id: "emc_shared",
      name: "Support Operations / slack",
      requiredBy: [
        { pluginId: "plg_support", name: "Support Operations" },
        { pluginId: "plg_triage", name: "Support Triage" },
      ],
    });
    const incompatibleSlackRows = [
      connection({ id: "emc_support", name: "Support Operations / slack" }),
      connection({ id: "emc_sales", name: "Sales Operations / slack" }),
    ];

    expect(formatRequiredBy(sharedSlack.requiredBy)).toBe("Required by Support Operations and Support Triage");
    expect(new Set(incompatibleSlackRows.map((entry) => entry.id)).size).toBe(2);
    expect(incompatibleSlackRows.map((entry) => entry.name)).toEqual(["Support Operations / slack", "Sales Operations / slack"]);
  });
});
