import { afterEach, describe, expect, test } from "bun:test";

import {
  createDenClient,
  DenApiError,
  type DenClient,
  type DenExternalMcpConnection,
  type DenLibraryAccessTargets,
  type DenMcpConnectionAccess,
  type DenMcpConnectionInput,
  type DenNativeProviderClient,
  type DenNativeProviderClientInput,
  type DenOrgPlugin,
  type DenPluginCloudReadiness,
} from "../src/app/lib/den";

const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
const orgId = "org_setup";
const connectionId = "emc_setup";
const providerId = "microsoft-365";
const updatedAt = "2026-09-14T12:00:00.000Z";
const access: DenMcpConnectionAccess = { orgWide: false, memberIds: ["mem_setup"], teamIds: ["tem_setup"] };
const connection: DenExternalMcpConnection = {
  id: connectionId,
  name: "Work service",
  url: "https://mcp.example.test/mcp",
  authType: "oauth",
  credentialMode: "per_member",
  exposeDirectly: false,
  connected: false,
  connectedAt: null,
  connectedForMe: false,
  updatedAt,
  access,
  oauthClientId: "public-client-id",
  oauthCallbackUrl: "https://api.den.example.test/v1/mcp-connections/oauth/callback",
  authorizationServerIssuer: "https://auth.example.test",
  requestedScopes: ["read"],
  identityManagedBy: [{ pluginId: "plg_setup", name: "Work plugin" }],
  setupRequired: true,
  oauthClientRequired: true,
  oauthClientConfigured: false,
  requiredAuthType: "oauth",
  authTypeMismatch: false,
};
const connectionInput: DenMcpConnectionInput = {
  name: connection.name,
  url: connection.url,
  authType: "oauth",
  credentialMode: "per_member",
  exposeDirectly: false,
  oauthClient: {
    clientId: "public-client-id",
    clientSecret: "test-client-secret",
    tokenEndpointAuthMethod: "client_secret_basic",
  },
  authorizationServerIssuer: "https://auth.example.test",
  requestedScopes: ["read"],
  access,
};
const nativeClient: DenNativeProviderClient = {
  providerId,
  configured: true,
  clientId: "public-native-client-id",
  features: ["mailRead"],
  scopes: ["User.Read", "Mail.Read"],
  redirectUri: "https://api.den.example.test/v1/oauth-providers/microsoft-365/connect/callback",
  tenantId: "tenant.example.test",
};
const nativeClientInput: DenNativeProviderClientInput = {
  clientId: nativeClient.clientId ?? undefined,
  clientSecret: "test-native-client-secret",
  features: ["mailRead"],
  tenantId: "tenant.example.test",
};
const nativeSaveReceipt = {
  ok: true,
  providerId,
  clientId: nativeClient.clientId,
  features: ["mailRead"],
  tenantId: "tenant.example.test",
};
const nativeConnectionInput = {
  nativeProviderKey: "google-workspace",
  name: "Work Google",
  oauthClient: { clientId: "public-google-client-id", clientSecret: "test-google-client-secret", features: [] },
};
const nativeConnection: DenExternalMcpConnection = {
  ...connection,
  name: "Work Google",
  nativeProviderKey: "google-workspace",
};
const pluginInput: Parameters<DenClient["configurePluginMcpConnection"]>[2] = {
  configObjectId: "cob_setup",
  serverName: "work-service",
  authType: "apikey",
  credentialMode: "shared",
  apiKey: "test-plugin-api-key",
};
const pluginReceipt = {
  ok: true,
  item: {
    binding: {
      id: "binding_setup",
      configObjectId: pluginInput.configObjectId,
      externalMcpConnectionId: connectionId,
      pluginId: "plg_setup",
      serverName: pluginInput.serverName,
    },
    connection: {
      id: connectionId,
      name: "Work service",
      url: connection.url,
      authType: "apikey",
      credentialMode: "shared",
      connected: true,
      connectedAt: updatedAt,
    },
    links: { yourConnections: "https://den.example.test/dashboard/your-connections" },
  },
};
const libraryPlugin: DenOrgPlugin = {
  id: "plg_setup",
  name: "Work plugin",
  description: null,
  status: "active",
  memberCount: 1,
  updatedAt,
  componentCounts: {},
  extension: null,
};
const secretFields = {
  apiKey: "test-response-api-key",
  accessToken: "test-response-access-token",
  refreshToken: "test-response-refresh-token",
  clientSecret: "test-response-client-secret",
  oauthClient: { clientId: "public-client-id", clientSecret: "test-nested-client-secret" },
};

const accessTargets: DenLibraryAccessTargets = {
  members: [{ id: "mem_setup", userId: "usr_setup", name: "Workspace member" }],
  teams: [{ id: "tem_setup", name: "Workspace team" }],
};
const accessTargetsResponse = {
  organization: { id: orgId, name: "Workspace", ...secretFields },
  members: [
    {
      id: "mem_setup",
      userId: "usr_setup",
      role: "admin",
      user: { id: "usr_setup", name: "Workspace member", email: "member@example.test", ...secretFields },
    },
    { id: "mem_invited", userId: null, inviteId: "invite_pending", user: { id: "mem_invited", name: "Invited member" } },
  ],
  teams: [{ id: "tem_setup", name: "Workspace team", memberIds: ["mem_setup"], grantsOrganizationAdmin: false }],
  invitations: [{ inviteToken: "test-invitation-token-not-returned" }],
};

function client() {
  return createDenClient({
    baseUrl: "https://den.example.test",
    apiBaseUrl: "https://api.den.example.test",
    token: "test-session-token",
  });
}

function mockResponses(responses: { payload: unknown; status?: number }[]) {
  const requests: { url: string; init?: RequestInit }[] = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = responses[requests.length];
      requests.push({ url: String(input), init });
      if (!response) throw new Error("Unexpected additional Den request.");
      return Response.json(response.payload, { status: response.status ?? 200 });
    },
  });
  return requests;
}

function mockResponse(payload: unknown, status = 200) {
  return mockResponses([{ payload, status }]);
}

async function expectDenError(action: Promise<unknown>, code: string, status: number): Promise<DenApiError> {
  let failure: unknown;
  try {
    await action;
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(DenApiError);
  if (!(failure instanceof DenApiError)) throw new Error("Expected a Den API error.");
  expect(failure.status).toBe(status);
  expect(failure.code).toBe(code);
  return failure;
}

const contracts: {
  name: string;
  run: (den: DenClient, organizationId: string) => Promise<unknown>;
  method: string;
  path: string;
  body?: unknown;
  response: unknown;
  expected: unknown;
  invalidCode: string;
}[] = [
  {
    name: "getLibraryAccessTargets",
    run: (den, organizationId) => den.getLibraryAccessTargets(organizationId),
    method: "GET",
    path: "/v1/org",
    response: accessTargetsResponse,
    expected: accessTargets,
    invalidCode: "invalid_library_access_targets_payload",
  },
  {
    name: "getMcpConnection",
    run: (den, organizationId) => den.getMcpConnection(organizationId, "emc/path ?"),
    method: "GET",
    path: "/v1/mcp-connections/emc%2Fpath%20%3F",
    response: { ...connection, ...secretFields },
    expected: connection,
    invalidCode: "invalid_mcp_connection_payload",
  },
  {
    name: "createMcpConnection",
    run: (den, organizationId) => den.createMcpConnection(organizationId, connectionInput),
    method: "POST",
    path: "/v1/mcp-connections",
    body: connectionInput,
    response: { ...connection, ...secretFields, links: { oauthCallback: connection.oauthCallbackUrl } },
    expected: connection,
    invalidCode: "invalid_mcp_connection_payload",
  },
  {
    name: "updateMcpConnection",
    run: (den, organizationId) => den.updateMcpConnection(organizationId, "emc/path ?", { ...connectionInput, expectedUpdatedAt: updatedAt }),
    method: "PUT",
    path: "/v1/mcp-connections/emc%2Fpath%20%3F",
    body: { ...connectionInput, expectedUpdatedAt: updatedAt },
    response: { ...connection, ...secretFields, identityChanged: false, reconnectionRequired: false },
    expected: connection,
    invalidCode: "invalid_mcp_connection_payload",
  },
  {
    name: "getNativeProviderClient",
    run: (den, organizationId) => den.getNativeProviderClient(organizationId, providerId),
    method: "GET",
    path: "/v1/oauth-providers/microsoft-365/client",
    response: { ...nativeClient, ...secretFields },
    expected: nativeClient,
    invalidCode: "invalid_native_provider_client_payload",
  },
  {
    name: "saveNativeProviderClient",
    run: (den, organizationId) => den.saveNativeProviderClient(organizationId, providerId, nativeClientInput),
    method: "POST",
    path: "/v1/oauth-providers/microsoft-365/client",
    body: nativeClientInput,
    response: { ...nativeSaveReceipt, ...secretFields },
    expected: undefined,
    invalidCode: "invalid_native_provider_client_payload",
  },
  {
    name: "createNativeProviderConnection",
    run: (den, organizationId) => den.createNativeProviderConnection(organizationId, nativeConnectionInput),
    method: "POST",
    path: "/v1/mcp-connections",
    body: { kind: "native_provider", ...nativeConnectionInput },
    response: { ...nativeConnection, ...secretFields },
    expected: nativeConnection,
    invalidCode: "invalid_mcp_connection_payload",
  },
  {
    name: "getLibraryPlugin",
    run: (den, organizationId) => den.getLibraryPlugin(organizationId, "plg/path ?"),
    method: "GET",
    path: "/v1/plugins/plg%2Fpath%20%3F",
    response: { item: { ...libraryPlugin, id: "plg/path ?", marketplaces: [], ...secretFields } },
    expected: { ...libraryPlugin, id: "plg/path ?" },
    invalidCode: "invalid_plugin_payload",
  },
  {
    name: "configurePluginMcpConnection",
    run: (den, organizationId) => den.configurePluginMcpConnection(organizationId, "plg/path ?", pluginInput),
    method: "POST",
    path: "/v1/plugins/plg%2Fpath%20%3F/mcp-connections",
    body: pluginInput,
    response: { ...pluginReceipt, ...secretFields },
    expected: { connectionId },
    invalidCode: "invalid_plugin_mcp_connection_payload",
  },
];

afterEach(() => {
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
  Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
});

describe("Den Library setup HTTP contracts", () => {
  for (const contract of contracts) {
    test(`${contract.name} uses the API origin, exact body, session and explicit organization without returning secrets`, async () => {
      const requests = mockResponse(contract.response);
      expect(await contract.run(client(), orgId)).toEqual(contract.expected);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe(`https://api.den.example.test${contract.path}`);
      const init = requests[0]?.init;
      expect(init?.method).toBe(contract.method);
      expect(init?.body).toBe(contract.body === undefined ? undefined : JSON.stringify(contract.body));
      expect(init?.credentials).toBe("include");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer test-session-token");
      expect(headers.get("x-openwork-org-id")).toBe(orgId);
      expect(headers.get("x-openwork-legacy-org-id")).toBe(orgId);
      expect(headers.get("accept")).toBe("application/json");
      expect(headers.get("content-type")).toBe(contract.body === undefined ? null : "application/json");
    });

    test(`${contract.name} refuses null and incomplete success payloads`, async () => {
      for (const payload of [null, {}, { ok: true }, { id: "" }]) {
        const requests = mockResponse(payload);
        await expectDenError(contract.run(client(), orgId), contract.invalidCode, 500);
        expect(requests).toHaveLength(1);
      }
    });

    test(`${contract.name} preserves Den error details without exposing the whole payload or retrying`, async () => {
      const details = { expectedUpdatedAt: updatedAt };
      const requests = mockResponse({
        error: "reauth",
        reason: "fresh_auth_required",
        message: "Confirm your identity before changing settings.",
        details,
        ...secretFields,
      }, 403);
      const failure = await expectDenError(contract.run(client(), orgId), "reauth", 403);
      expect(failure.message).toBe("Confirm your identity before changing settings.");
      expect(failure.details).toEqual(details);
      expect(JSON.stringify(failure)).not.toContain("test-response-");
      expect(requests).toHaveLength(1);
    });

    test(`${contract.name} refuses an implicit organization`, async () => {
      const requests = mockResponse(contract.response);
      await expectDenError(contract.run(client(), "  "), "organization_required", 400);
      expect(requests).toHaveLength(0);
    });
  }

  test("access targets map user IDs to membership IDs and exclude invitation and credential data", async () => {
    mockResponse(accessTargetsResponse);
    const targets = await client().getLibraryAccessTargets(orgId);
    expect(targets.members.find((member) => member.userId === "usr_setup")?.id).toBe("mem_setup");
    expect(targets.members.some((member) => member.id === "mem_invited")).toBe(false);
    expect(targets).toEqual(accessTargets);
    expect(JSON.stringify(targets)).not.toContain("email");
    expect(JSON.stringify(targets)).not.toContain("test-response-");
    expect(JSON.stringify(targets)).not.toContain("inviteToken");
  });

  test("access targets reject wrong organizations, incomplete identities and malformed teams", async () => {
    for (const payload of [
      { ...accessTargetsResponse, organization: { id: "org_other" } },
      { ...accessTargetsResponse, members: undefined },
      { ...accessTargetsResponse, teams: undefined },
      { ...accessTargetsResponse, members: [{ id: "mem_setup", user: { id: "usr_setup", name: "Member" } }] },
      { ...accessTargetsResponse, members: [{ id: "mem_setup", userId: "usr_setup", user: { id: "usr_other", name: "Member" } }] },
      { ...accessTargetsResponse, teams: [{ id: "tem_setup" }] },
    ]) {
      mockResponse(payload);
      await expectDenError(client().getLibraryAccessTargets(orgId), "invalid_library_access_targets_payload", 500);
    }
    mockResponse({ organization: { id: orgId }, members: [], teams: [] });
    expect(await client().getLibraryAccessTargets(orgId)).toEqual({ members: [], teams: [] });
  });

  test("connection edits retain every existing grant independently of currently selectable access targets", async () => {
    const existingAccess = { orgWide: false, memberIds: ["mem_setup", "mem_existing"], teamIds: ["tem_setup", "tem_existing"] };
    const existing = { ...connection, access: existingAccess };
    const requests = mockResponses([
      { payload: accessTargetsResponse },
      { payload: existing },
      { payload: existing },
    ]);
    const den = client();
    await den.getLibraryAccessTargets(orgId);
    const loaded = await den.getMcpConnection(orgId, connectionId);
    if (!loaded.access || !loaded.updatedAt) throw new Error("Expected editable connection access.");
    await den.updateMcpConnection(orgId, connectionId, { ...connectionInput, access: loaded.access, expectedUpdatedAt: loaded.updatedAt });
    const body: unknown = JSON.parse(String(requests[2]?.init?.body));
    expect(body).toMatchObject({ access: existingAccess, expectedUpdatedAt: updatedAt });
  });

  test("passes API keys only in creation bodies and preserves explicit empty access", async () => {
    const input: DenMcpConnectionInput = {
      name: "Key service",
      url: connection.url,
      authType: "apikey",
      credentialMode: "shared",
      apiKey: "test-input-api-key",
      access: { orgWide: false, memberIds: [], teamIds: [] },
    };
    const requests = mockResponse({ ...connection, ...input, ...secretFields });
    const result = await client().createMcpConnection(orgId, input);
    expect(requests[0]?.init?.body).toBe(JSON.stringify(input));
    expect(result).not.toHaveProperty("apiKey");
    expect(result.access).toEqual(input.access);
    expect(requests[0]?.url).not.toContain(input.apiKey ?? "missing");
  });

  test("native creation requires the provider identity from the receipt instead of inferring it from input", async () => {
    for (const nativeProviderKey of [undefined, null, "", "microsoft-365"]) {
      const requests = mockResponse({ ...nativeConnection, nativeProviderKey });
      await expectDenError(client().createNativeProviderConnection(orgId, nativeConnectionInput), "invalid_mcp_connection_payload", 500);
      expect(requests).toHaveLength(1);
    }
    mockResponse({ ...nativeConnection, ...secretFields });
    const created = await client().createNativeProviderConnection(orgId, nativeConnectionInput);
    expect(created.nativeProviderKey).toBe("google-workspace");
    expect(created.id).toBe(connectionId);
    expect(created).not.toHaveProperty("oauthClient");
  });

  test("getLibraryPlugin refreshes standalone readiness directly without scanning marketplaces", async () => {
    const ready: DenPluginCloudReadiness = {
      state: "ready",
      hasInstructional: false,
      connections: [{
        id: connectionId,
        name: connection.name,
        url: connection.url,
        configObjectId: "cob_setup",
        serverName: "work-service",
        credentialMode: "per_member",
        connectedForMe: true,
        authType: "oauth",
        requiredAuthType: "oauth",
        authTypeMismatch: false,
        oauthClientRequired: true,
        oauthClientConfigured: true,
      }],
    };
    const needsSignin: DenPluginCloudReadiness = {
      ...ready,
      state: "needs_signin",
      connections: ready.connections.map((entry) => ({ ...entry, connectedForMe: false })),
    };
    const detail = (cloudReadiness: DenPluginCloudReadiness) => ({
      item: { ...libraryPlugin, componentCounts: { mcp: 1 }, marketplaces: [], cloudReadiness, ...secretFields },
    });
    const requests = mockResponses([
      { payload: detail(ready) },
      { payload: detail(needsSignin) },
    ]);
    const den = client();
    expect(await den.getLibraryPlugin(orgId, libraryPlugin.id)).toEqual({ ...libraryPlugin, componentCounts: { mcp: 1 }, cloudReadiness: ready });
    expect(await den.getLibraryPlugin(orgId, libraryPlugin.id)).toEqual({ ...libraryPlugin, componentCounts: { mcp: 1 }, cloudReadiness: needsSignin });
    expect(requests.map((entry) => entry.url)).toEqual([
      "https://api.den.example.test/v1/plugins/plg_setup",
      "https://api.den.example.test/v1/plugins/plg_setup",
    ]);
    for (const request of requests) {
      expect(request.init?.method).toBe("GET");
      expect(request.init?.body).toBeUndefined();
      const headers = new Headers(request.init?.headers);
      expect(headers.get("authorization")).toBe("Bearer test-session-token");
      expect(headers.get("x-openwork-org-id")).toBe(orgId);
    }
  });

  test("getLibraryPlugin does not fabricate readiness on older or Connect-disabled servers", async () => {
    const requests = mockResponses([
      { payload: { item: { ...libraryPlugin, marketplaces: [] } } },
      { payload: { item: { ...libraryPlugin, marketplaces: [{ id: "mkt_setup", name: "Work marketplace" }] } } },
    ]);
    const den = client();
    expect(await den.getLibraryPlugin(orgId, libraryPlugin.id)).toEqual(libraryPlugin);
    expect(await den.getLibraryPlugin(orgId, libraryPlugin.id)).toEqual(libraryPlugin);
    expect(requests).toHaveLength(2);
  });

  test("getLibraryPlugin rejects mismatched or malformed readiness and propagates authorization failures", async () => {
    for (const item of [
      { ...libraryPlugin, id: "plg_other" },
      { ...libraryPlugin, cloudReadiness: { state: "unknown", hasInstructional: false, connections: [] } },
      { ...libraryPlugin, cloudReadiness: { state: "ready", hasInstructional: false, connections: [{}] } },
    ]) {
      mockResponse({ item });
      await expectDenError(client().getLibraryPlugin(orgId, libraryPlugin.id), "invalid_plugin_payload", 500);
    }
    const requests = mockResponse({ error: "forbidden", message: "Plugin access denied." }, 403);
    await expectDenError(client().getLibraryPlugin(orgId, libraryPlugin.id), "forbidden", 403);
    expect(requests).toHaveLength(1);
  });

  test("permission-only native saves omit credentials and retain an explicit empty feature selection", async () => {
    const requests = mockResponse({ ...nativeSaveReceipt, features: [] });
    await client().saveNativeProviderClient(orgId, providerId, { features: [] });
    expect(requests[0]?.init?.body).toBe('{"features":[]}');
  });

  test("native configuration supports unconfigured and named providers without alias fallback", async () => {
    const namedProviderId = "emc/provider ?";
    const payload = { ...nativeClient, providerId: namedProviderId, configured: false, clientId: null, tenantId: null, features: [], scopes: [] };
    const requests = mockResponse(payload);
    expect(await client().getNativeProviderClient(orgId, namedProviderId)).toEqual(payload);
    expect(requests[0]?.url).toBe("https://api.den.example.test/v1/oauth-providers/emc%2Fprovider%20%3F/client");
  });

  test("rejects mismatched or malformed native client receipts", async () => {
    for (const payload of [
      { ...nativeClient, providerId: "another-provider" },
      { ...nativeClient, clientId: null },
      { ...nativeClient, features: ["mailRead", 1] },
      { ...nativeClient, scopes: null },
      { ...nativeClient, redirectUri: "" },
      { ...nativeClient, tenantId: undefined },
    ]) {
      mockResponse(payload);
      await expectDenError(client().getNativeProviderClient(orgId, providerId), "invalid_native_provider_client_payload", 500);
    }
    for (const payload of [
      { ...nativeSaveReceipt, ok: false },
      { ...nativeSaveReceipt, providerId: "another-provider" },
      { ...nativeSaveReceipt, clientId: " " },
      { ...nativeSaveReceipt, features: [false] },
      { ...nativeSaveReceipt, tenantId: undefined },
    ]) {
      mockResponse(payload);
      await expectDenError(client().saveNativeProviderClient(orgId, providerId, { features: [] }), "invalid_native_provider_client_payload", 500);
    }
  });

  test("rejects missing connection IDs, readiness fields and malformed editable metadata", async () => {
    for (const payload of [
      { ...connection, id: " " },
      { ...connection, name: undefined },
      { ...connection, connectedForMe: undefined },
      { ...connection, connectedAt: undefined },
      { ...connection, access: { orgWide: false, memberIds: [1], teamIds: [] } },
      { ...connection, identityManagedBy: [{ pluginId: "plg_setup" }] },
      { ...connection, requestedScopes: ["read", false] },
      { ...connection, requiredAuthType: "basic" },
      { ...connection, setupRequired: "false" },
    ]) {
      mockResponse(payload);
      await expectDenError(client().createMcpConnection(orgId, connectionInput), "invalid_mcp_connection_payload", 500);
    }
  });

  test("accepts absent legacy metadata and preserves explicit null, empty and false setup facts", async () => {
    const legacy: DenExternalMcpConnection = {
      id: connectionId, name: "Legacy", url: connection.url, authType: "none", credentialMode: "shared",
      exposeDirectly: false, connected: true, connectedForMe: true, connectedAt: updatedAt,
    };
    mockResponse(legacy);
    expect(await client().getMcpConnection(orgId, connectionId)).toEqual(legacy);
    const nullable = {
      ...connection, access: null, oauthClientId: null, oauthCallbackUrl: null, authorizationServerIssuer: null,
      requestedScopes: [], identityManagedBy: [], requiredAuthType: null,
      setupRequired: false, oauthClientRequired: false, oauthClientConfigured: false, authTypeMismatch: false,
    };
    mockResponse({ connections: [nullable] });
    expect(await client().listMcpConnections(orgId, "manageable")).toEqual([nullable]);
  });

  test("strips unknown nested fields from connection access and plugin ownership", async () => {
    mockResponse({
      ...connection,
      access: { ...access, ...secretFields },
      identityManagedBy: [{ pluginId: "plg_setup", name: "Work plugin", ...secretFields }],
    });
    expect(await client().getMcpConnection(orgId, connectionId)).toEqual(connection);
  });

  test("requires a real plugin binding and matching connection instead of guessing an ID", async () => {
    for (const payload of [
      { connectionId },
      { ...pluginReceipt, ok: false },
      { ok: true, item: { connection: pluginReceipt.item.connection } },
      { ok: true, item: { ...pluginReceipt.item, binding: { ...pluginReceipt.item.binding, externalMcpConnectionId: "emc_other" } } },
      { ok: true, item: { ...pluginReceipt.item, connection: { ...pluginReceipt.item.connection, id: " " } } },
      { ok: true, item: { ...pluginReceipt.item, connection: { ...pluginReceipt.item.connection, connected: undefined } } },
    ]) {
      mockResponse(payload);
      await expectDenError(client().configurePluginMcpConnection(orgId, "plg_setup", pluginInput), "invalid_plugin_mcp_connection_payload", 500);
    }
  });

  test("retains preset OAuth requirements and alternate supported authentication modes", async () => {
    const preset = {
      presetId: "work-service", displayName: "Work service", description: "Work integration", url: connection.url,
      authType: "oauth", requiresOAuthClient: true, supportedAuthTypes: ["oauth", "apikey"],
    };
    mockResponse({ presets: [preset, { ...preset, supportedAuthTypes: ["basic"] }] });
    expect(await client().listMcpConnectionPresets(orgId)).toEqual([preset]);
  });

  test("preserves the plugin readiness authentication requirements from resolved marketplaces", async () => {
    const readinessConnection = {
      id: connectionId,
      configObjectId: "cob_setup",
      serverName: "work-service",
      name: connection.name,
      url: connection.url,
      authType: "oauth",
      credentialMode: "per_member",
      connectedForMe: false,
      requiredAuthType: "oauth",
      authTypeMismatch: false,
      oauthClientRequired: true,
      oauthClientConfigured: false,
    };
    mockResponse({
      ok: true,
      item: {
        marketplace: { id: "mkt_setup", name: "Work marketplace" },
        plugins: [{
          id: "plg_setup",
          name: "Work plugin",
          cloudReadiness: {
            state: "needs_admin_setup",
            hasInstructional: false,
            connections: [{ ...readinessConnection, ...secretFields }],
          },
        }],
      },
    });
    const resolved = await client().getOrgMarketplaceResolved(orgId, "mkt_setup");
    expect(resolved.plugins[0]?.cloudReadiness?.connections).toEqual([readinessConnection]);
  });

  test("preserves conflict and upstream errors without replacing them with response-validation failures", async () => {
    for (const failure of [
      { status: 409, code: "connection_conflict" },
      { status: 409, code: "marketplace_managed" },
      { status: 502, code: "connection_validation_failed" },
    ]) {
      const requests = mockResponse({ error: failure.code, message: "Review the connection before continuing." }, failure.status);
      await expectDenError(client().updateMcpConnection(orgId, connectionId, { ...connectionInput, expectedUpdatedAt: updatedAt }), failure.code, failure.status);
      expect(requests).toHaveLength(1);
    }
  });

  test("continues using Electron main-process transport for a different loopback API origin", async () => {
    const requests: { command: string; url: string; init: { method?: string; headers?: Record<string, string>; body?: string } }[] = [];
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { origin: "http://127.0.0.1:5173" },
        __OPENWORK_ELECTRON__: {
          invokeDesktop: async (command: string, url: string, init: { method?: string; headers?: Record<string, string>; body?: string }) => {
            requests.push({ command, url, init });
            return { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(connection) };
          },
        },
      },
    });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async () => { throw new Error("Renderer fetch must not run for cross-origin Desktop setup."); },
    });
    const den = createDenClient({ baseUrl: "http://127.0.0.1:3000", apiBaseUrl: "http://127.0.0.1:8788", token: "test-session-token" });
    expect(await den.createMcpConnection(orgId, connectionInput)).toEqual(connection);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.command).toBe("__fetch");
    expect(requests[0]?.url).toBe("http://127.0.0.1:8788/v1/mcp-connections");
    expect(requests[0]?.init.method).toBe("POST");
    expect(requests[0]?.init.body).toBe(JSON.stringify(connectionInput));
    expect(requests[0]?.init.headers?.authorization).toBe("Bearer test-session-token");
    expect(requests[0]?.init.headers?.["x-openwork-org-id"]).toBe(orgId);
  });
});
