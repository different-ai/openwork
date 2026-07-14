import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { getMcpConnectionsRoute, getMcpPluginImportRoute } from "../app/(den)/_lib/den-org";
import {
  effectiveMcpAccess,
  formatInheritedMcpAccess,
  formatRequiredBy,
  sortConnectionsForFocus,
  trustedConnectionFocusId,
} from "../app/(den)/dashboard/_components/mcp-connection-display";
import {
  parseExternalMcpConfigurationDiscovery,
  type ExternalMcpConfigurationDiscovery,
  type ExternalMcpConnection,
  type ExternalMcpPreset,
  type ExternalMcpRequiredBy,
} from "../app/(den)/dashboard/_components/mcp-connections-data";
import {
  parseConfiguredPluginMcpConnection,
  parseMarketplacePluginMcpDiscovery,
  parseMarketplaceResolvedPayload,
  type MarketplacePluginCloudReadinessConnection,
} from "../app/(den)/dashboard/_components/marketplace-data";
import {
  discoveredAuthType,
  discoveryAuthControlCopy,
  discoveryAuthIsEditable,
  discoveryDocumentationLabel,
  discoveryHasUnsupportedRequirements,
  discoveryNeedsInput,
  discoveryRegistrationCopy,
} from "../app/(den)/dashboard/_components/mcp-discovery-summary";
import {
  githubImportServerNeedsExplicitReview,
  githubImportServerSelectedByDefault,
  parseGithubImportedMcpOAuthCallbacks,
  parseGithubPluginImportPreview,
} from "../app/(den)/dashboard/_components/mcp-connections-screen";
import {
  findPresetForRequirement,
  pluginReadinessConnectionAction,
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
    updatedAt: null,
    connectedForMe: false,
    requiredBy: input.requiredBy ?? [],
    identityManagedBy: [],
    access: null,
    inheritedAccess: null,
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

function oauthDiscovery(overrides: Partial<ExternalMcpConfigurationDiscovery> = {}): ExternalMcpConfigurationDiscovery {
  return {
    auth: { confidence: "verified", kind: "oauth", source: "live_protocol" },
    inputs: [],
    oauth: {
      authorizationServer: "https://auth.example.com/",
      clientIdRequired: false,
      clientSecretRequired: false,
      documentationUrl: null,
      pkce: "s256",
      registration: "dynamic",
      scopes: ["read:issues", "write:issues"],
      scopesSource: "challenge",
    },
    support: { status: "auto_configurable" },
    transport: { kind: "remote_http", supported: true, url: "https://mcp.example.com/mcp" },
    warnings: [],
    ...overrides,
  };
}

describe("marketplace MCP readiness parsing", () => {
  test("labels publisher-controlled documentation with its destination host", () => {
    expect(discoveryDocumentationLabel("https://docs.provider.example/oauth/setup")).toBe(
      "Publisher-provided setup guide (docs.provider.example)",
    );
  });
  test("routes the legacy GitHub entry point exclusively into the shared Connections importer", () => {
    const editorSource = readFileSync(new URL("../app/(den)/dashboard/_components/plugin-editor-screen.tsx", import.meta.url), "utf8");
    const connectionsSource = readFileSync(new URL("../app/(den)/dashboard/_components/mcp-connections-screen.tsx", import.meta.url), "utf8");

    expect(getMcpPluginImportRoute("design")).toBe(`${getMcpConnectionsRoute("design")}?add=plugin`);
    expect(editorSource).toContain("href={getMcpPluginImportRoute(orgSlug)}");
    expect(editorSource).not.toContain("/v1/plugins/import-mcps-from-github-url");
    expect(editorSource).not.toContain("githubImportAuthType");
    expect(connectionsSource).toContain('searchParams.get("add") === "plugin"');
  });

  test("pre-opens OAuth windows and exposes a same-tab fallback when popups are blocked", () => {
    const adminSource = readFileSync(new URL("../app/(den)/dashboard/_components/mcp-connections-screen.tsx", import.meta.url), "utf8");
    const memberSource = readFileSync(new URL("../app/(den)/dashboard/_components/your-connections-screen.tsx", import.meta.url), "utf8");

    for (const source of [adminSource, memberSource]) {
      expect(source).toContain("= openMcpAuthorizationWindow(connectionId)");
      expect(source).toContain("navigateMcpAuthorizationWindow(authorizationWindow, result.authorizeUrl)");
      expect(source).toContain("Your browser blocked the sign-in window.");
      expect(source).toContain("Continue sign-in in this tab");
      expect(source).toContain("if (authorizationWindow.closed)");
      expect(source).not.toContain("window.open(safeMcpAuthorizationUrl");
    }
    expect(adminSource).toContain("openMcpAuthorizationWindow(`new-${input.name}`)");
  });

  test("confirms direct removal and blocks deletion while a plugin still requires the connection", () => {
    const source = readFileSync(new URL("../app/(den)/dashboard/_components/mcp-connections-screen.tsx", import.meta.url), "utf8");

    expect(source).toContain("window.confirm(`Remove “${connection.name}”?");
    expect(source).toContain("await deleteConnection.mutateAsync(connection.id)");
    expect(source).toContain("removeError instanceof Error ? removeError.message");
    expect(source).toContain("void refetch()");
    expect(source).toContain("errorMessage={connectionActionError?.connectionId === connection.id");
    expect(source).toContain("Required by {requiredByNames.join(\", \")}");
    expect(source).toContain("disabled={requiredByNames.length > 0}");
    expect(source).toContain("Remove it from the plugin before deleting this connection.");
  });

  test("keeps direct and inherited assignments separate while summarizing their effective union", () => {
    expect(effectiveMcpAccess(
      { orgWide: false, memberIds: ["member_direct"], teamIds: ["team_direct"] },
      { orgWide: false, memberIds: ["member_inherited", "member_direct"], teamIds: ["team_support"] },
    )).toEqual({
      orgWide: false,
      memberIds: ["member_direct", "member_inherited"],
      teamIds: ["team_direct", "team_support"],
    });
    expect(formatInheritedMcpAccess(
      { orgWide: false, memberIds: ["member_maya"], teamIds: ["team_support"] },
      [{ id: "team_support", name: "Support" }],
      [{ id: "member_maya", name: "Maya" }],
    )).toBe("Support team and Maya");

    const source = readFileSync(new URL("../app/(den)/dashboard/_components/mcp-connections-screen.tsx", import.meta.url), "utf8");
    expect(source).toContain("effectiveMcpAccess(connection.access, connection.inheritedAccess)");
    expect(source).toContain("Inherited plugin access:");
    expect(source).toContain("Additional direct assignments");
    expect(source).toContain("never replace plugin access");
    expect(source).toContain('value: "none", label: marketplaceManaged ? "Inherited only" : "Nobody"');
  });

  test("guarantees marketplace eval teardown after early failures", () => {
    const runnerSource = readFileSync(new URL("../../../../evals/runner/run.mjs", import.meta.url), "utf8");
    const flowSource = readFileSync(new URL("../../../../evals/flows/marketplace-plugin-mcp-auth.flow.mjs", import.meta.url), "utf8");

    expect(runnerSource).toContain('if (typeof flow.teardown === "function")');
    expect(runnerSource).toContain('name: "Teardown"');
    expect(runnerSource.indexOf("await flow.teardown(ctx)")).toBeLessThan(runnerSource.indexOf("ctx.client?.close()"));
    expect(flowSource).toContain("teardown: teardownMarketplacePluginMcpAuth");
    expect(flowSource).toContain("throw new AggregateError");
    expect(flowSource).toContain('["managed MCP connections", cleanupConnections]');
    expect(flowSource).not.toContain('name: "Cleanup"');
  });

  test("requires explicit trust review before selecting executable GitHub skills", () => {
    const connectionsSource = readFileSync(new URL("../app/(den)/dashboard/_components/mcp-connections-screen.tsx", import.meta.url), "utf8");

    expect(connectionsSource).not.toContain("setSelectedSkillKeys(nextPreview.skills.filter");
    expect(connectionsSource).toContain("Review skills before importing.");
    expect(connectionsSource).toContain("Skills can contain executable guidance");
    expect(connectionsSource).toContain("preview.sourceRevisionRef.slice(0, 12)");
  });

  test("does not auto-select GitHub MCPs whose authentication still needs review", () => {
    const inferredNoAuth = parseGithubPluginImportPreview({
      item: {
        repositoryFullName: "example/mcp-plugin",
        rootPath: "",
        sourceRevisionRef: "a1b2c3d4",
        servers: [{
          authType: "none",
          discovery: oauthDiscovery({
            auth: { confidence: "inferred", kind: "none", source: "live_protocol" },
            oauth: null,
            support: { status: "needs_review" },
          }),
          name: "initialize-only",
          serverKey: "initialize-only:key",
          skippedReason: null,
          supported: true,
          url: "https://mcp.example.com/mcp",
        }],
        skills: [],
        warnings: [],
      },
    }).servers[0]!;

    expect(githubImportServerNeedsExplicitReview(inferredNoAuth)).toBe(true);
    expect(githubImportServerSelectedByDefault(inferredNoAuth)).toBe(false);
    expect(githubImportServerSelectedByDefault({ ...inferredNoAuth, discovery: oauthDiscovery() })).toBe(true);
  });

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
              configObjectId: "cfg_slack",
              id: null,
              name: "slack",
              serverName: "slack",
              url: "https://mcp.slack.com/mcp",
            }],
          },
        }],
        source: null,
      },
    });

    expect(parsed.plugins[0]?.cloudReadiness?.connections[0]).toEqual({
      configObjectId: "cfg_slack",
      id: null,
      name: "slack",
      serverName: "slack",
      url: "https://mcp.slack.com/mcp",
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

  test("uses discovered auth ahead of an unmatched preset fallback", () => {
    const discovery = oauthDiscovery({
      auth: { confidence: "verified", kind: "none", source: "live_protocol" },
      oauth: null,
    });

    expect(pluginSetupInitialState(null, discovery)).toEqual({ authAssumed: false, authType: "none", credentialMode: "shared" });
    expect(discoveredAuthType(discovery, "oauth")).toBe("none");
  });

  test("locks known auth evidence and allows review only for inferred or unknown evidence", () => {
    const declared = oauthDiscovery({ auth: { confidence: "declared", kind: "oauth", source: "plugin_manifest" } });
    const curated = oauthDiscovery({ auth: { confidence: "curated", kind: "oauth", source: "openwork_preset" } });
    const inferred = oauthDiscovery({ auth: { confidence: "inferred", kind: "oauth", source: "oauth_metadata" } });
    const unknown = oauthDiscovery({ auth: { confidence: "unknown", kind: "unknown", source: "unknown" } });

    expect(discoveryAuthIsEditable(oauthDiscovery())).toBe(false);
    expect(discoveryAuthIsEditable(declared)).toBe(false);
    expect(discoveryAuthIsEditable(curated)).toBe(false);
    expect(discoveryAuthIsEditable(inferred)).toBe(true);
    expect(discoveryAuthIsEditable(unknown)).toBe(true);
    expect(discoveryAuthControlCopy(declared)).toContain("Declared by the plugin");
    expect(discoveryAuthControlCopy(inferred)).toContain("Confirm the choice");
  });

  test("parses OAuth discovery, requested scopes, and dynamic registration", () => {
    const discovery = parseExternalMcpConfigurationDiscovery(oauthDiscovery());

    expect(discovery?.oauth?.scopes).toEqual(["read:issues", "write:issues"]);
    expect(discovery?.oauth?.scopesSource).toBe("challenge");
    expect(discoveryRegistrationCopy(discovery)).toContain("automatic OAuth app registration");
    expect(discoveryNeedsInput(discovery, "oauth_client_id")).toBe(false);
    expect(discoveryHasUnsupportedRequirements(discovery)).toBe(false);
  });

  test("requires only the OAuth client values advertised by a public client", () => {
    const discovery = oauthDiscovery({
      inputs: [{
        id: "oauth_client_id:value",
        label: "OAuth client ID",
        placement: "oauth_client_id",
        required: true,
        secret: false,
        source: "oauth_metadata",
        supported: true,
        variable: null,
      }],
      oauth: {
        authorizationServer: "https://auth.example.com/",
        clientIdRequired: true,
        clientSecretRequired: false,
        documentationUrl: null,
        pkce: "s256",
        registration: "pre_registered",
        scopes: [],
        scopesSource: "none",
      },
      support: { status: "needs_manual_oauth_client" },
    });

    expect(discoveryNeedsInput(discovery, "oauth_client_id")).toBe(true);
    expect(discoveryNeedsInput(discovery, "oauth_client_secret")).toBe(false);
    expect(discoveryRegistrationCopy(discovery)).toContain("secret is not required");
  });

  test("blocks cloud setup when a plugin requires unsupported custom headers", () => {
    const discovery = oauthDiscovery({
      inputs: [{
        id: "header:x-tenant",
        label: "Tenant header",
        placement: "header",
        required: true,
        secret: false,
        source: "plugin_manifest",
        supported: false,
        variable: "TENANT_ID",
      }],
      support: { status: "unsupported" },
    });

    expect(discoveryHasUnsupportedRequirements(discovery)).toBe(true);
  });

  test("blocks OAuth setup when the authorization server omits PKCE S256", () => {
    const discovery = oauthDiscovery({
      oauth: {
        authorizationServer: "https://auth.example.com/",
        clientIdRequired: false,
        clientSecretRequired: false,
        documentationUrl: null,
        pkce: "missing",
        registration: "dynamic",
        scopes: [],
        scopesSource: "none",
      },
      warnings: ["The authorization server did not advertise required PKCE S256 support."],
    });

    expect(discoveryHasUnsupportedRequirements(discovery)).toBe(true);
  });

  test("parses plugin discovery with effective union assignment", () => {
    const parsed = parseMarketplacePluginMcpDiscovery({
      ok: true,
      item: {
        assignment: {
          access: { orgWide: false, memberIds: ["member_1"], teamIds: ["team_1"] },
          policy: "union_of_active_config_object_plugin_and_marketplace_grants",
        },
        configObjectId: "cfg_1",
        discovery: oauthDiscovery(),
        pluginId: "plugin_1",
        serverName: "issues",
        url: "https://mcp.example.com/mcp",
      },
    });

    expect(parsed.assignment.access).toEqual({ orgWide: false, memberIds: ["member_1"], teamIds: ["team_1"] });
    expect(parsed.discovery.auth.kind).toBe("oauth");
  });

  test("preserves the deployment-derived OAuth callback after marketplace setup", () => {
    const parsed = parseConfiguredPluginMcpConnection({
      item: {
        connection: { id: "emc_issues" },
        links: {
          oauthCallback: "https://api.openwork.example/v1/mcp-connections/emc_issues/connect/callback",
          yourConnections: "https://app.openwork.example/dashboard/your-connections?connectionId=emc_issues",
        },
      },
    });

    expect(parsed.oauthCallback).toContain("/emc_issues/connect/callback");
    expect(parsed.yourConnectionsUrl).toContain("connectionId=emc_issues");
  });

  test("preserves per-server discovery and the reviewed GitHub revision", () => {
    const parsed = parseGithubPluginImportPreview({
      item: {
        repositoryFullName: "example/mcp-plugin",
        rootPath: "plugins/issues",
        sourceRevisionRef: "a1b2c3d4",
        servers: [{
          authType: "oauth",
          discovery: oauthDiscovery(),
          name: "issues",
          serverKey: "issues:key",
          skippedReason: null,
          supported: true,
          url: "https://mcp.example.com/mcp",
        }],
        skills: [],
        warnings: ["Live discovery was capped."],
      },
    });

    expect(parsed.sourceRevisionRef).toBe("a1b2c3d4");
    expect(parsed.servers[0]?.discovery?.oauth?.scopes).toEqual(["read:issues", "write:issues"]);
    expect(parsed.warnings).toEqual(["Live discovery was capped."]);
  });

  test("keeps only complete post-import OAuth callback checklist entries", () => {
    const callbacks = parseGithubImportedMcpOAuthCallbacks({
      item: {
        imported: [
          {
            connectionId: "emc_issues",
            name: "Issues MCP",
            oauthCallback: "https://api.openwork.example/v1/mcp-connections/emc_issues/connect/callback",
          },
          { connectionId: "emc_public", name: "Public MCP", oauthCallback: null },
          { name: "Incomplete MCP", oauthCallback: "https://example.com/callback" },
        ],
      },
    });

    expect(callbacks).toEqual([{
      connectionId: "emc_issues",
      name: "Issues MCP",
      oauthCallback: "https://api.openwork.example/v1/mcp-connections/emc_issues/connect/callback",
    }]);
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
