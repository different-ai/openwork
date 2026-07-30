import { mock } from "bun:test";

const rootUrl = new URL("../../../", import.meta.url);
const oauthClientSecret = "synthetic-test-client-secret-32-bytes";
const observedRequests = [];
const stores = new Map();

function rootHref(path) {
  return new URL(path, rootUrl).href;
}

function mockDenModule(path, factory) {
  mock.module(rootHref(path.replace(/\.ts$/u, ".js")), factory);
  mock.module(rootHref(path), factory);
}

class PrivateUrlError extends Error {
  constructor(url, reason) {
    super(reason);
    this.name = "PrivateUrlError";
    this.url = url;
  }
}

async function observedFetch(url, init) {
  const body = typeof init?.body === "string"
    ? init.body
    : init?.body instanceof URLSearchParams
      ? init.body.toString()
      : "";
  observedRequests.push({
    method: (init?.method ?? "GET").toUpperCase(),
    url: String(url),
    body,
  });
  return fetch(url, init);
}

function createStore() {
  return {
    authorizationRecords: new Map(),
    credential: undefined,
    discoveryState: undefined,
    invalidationReasons: [],
    registration: undefined,
    revision: 0,
  };
}

function storeFor(connectionId) {
  const existing = stores.get(connectionId);
  if (existing) return existing;
  const store = createStore();
  stores.set(connectionId, store);
  return store;
}

function nextRevision(store) {
  store.revision += 1;
  return `revision-${store.revision}`;
}

function assertPersistenceActive(input) {
  if (input?.signal?.aborted || input?.commitExpiresAt <= Date.now()) {
    throw new Error("persistence deadline expired");
  }
}

class MockDenEnterpriseMcpOAuthPersistence {
  constructor(connection) {
    this.store = storeFor(String(connection.id));
    this.clientRegistrations = {
      load: async (context) => {
        assertPersistenceActive(context);
        return this.store.registration;
      },
      save: async (input) => {
        assertPersistenceActive(input.context);
        if (!this.store.registration) {
          this.store.registration = {
            clientInformation: input.clientInformation,
            expiresAt: input.expiresAt,
            revision: nextRevision(this.store),
            source: input.source,
          };
        }
        return this.store.registration;
      },
      invalidate: async (input) => {
        assertPersistenceActive(input.context);
        this.store.registration = undefined;
        this.store.invalidationReasons.push(`client:${input.reason}`);
      },
    };
    this.credentials = {
      load: async (context) => {
        assertPersistenceActive(context);
        return this.store.credential;
      },
      save: async (input) => {
        assertPersistenceActive(input.context);
        if (input.source === "authorization-code") {
          const id = input.authorization?.id;
          const pending = id ? this.store.authorizationRecords.get(id) : undefined;
          if (!pending || pending.handle.revision !== input.authorization?.revision) {
            throw new Error("authorization was not active");
          }
          this.store.authorizationRecords.delete(id);
        }
        this.store.credential = {
          expiresAt: input.expiresAt,
          revision: nextRevision(this.store),
          tokens: input.tokens,
        };
      },
      invalidate: async (input) => {
        assertPersistenceActive(input.context);
        this.store.credential = undefined;
        this.store.invalidationReasons.push(`tokens:${input.reason}`);
      },
    };
    this.authorizations = {
      begin: async (input) => {
        assertPersistenceActive(input.context);
        this.store.authorizationRecords.set(input.id, {
          codeVerifier: input.codeVerifier,
          handle: {
            clientRegistrationRevision: input.clientRegistrationRevision,
            expiresAt: input.expiresAt,
            id: input.id,
            revision: nextRevision(this.store),
          },
        });
      },
      load: async (input) => {
        assertPersistenceActive(input.context);
        return this.store.authorizationRecords.get(input.id);
      },
      invalidate: async (input) => {
        assertPersistenceActive(input.context);
        this.store.authorizationRecords.delete(input.id);
        this.store.invalidationReasons.push(`authorization:${input.reason}`);
      },
    };
    this.discovery = {
      load: async (context) => {
        assertPersistenceActive(context);
        return this.store.discoveryState;
      },
      save: async (input) => {
        assertPersistenceActive(input.context);
        this.store.discoveryState = input.state;
      },
      invalidate: async (input) => {
        assertPersistenceActive(input.context);
        this.store.discoveryState = undefined;
        this.store.invalidationReasons.push(`discovery:${input.reason}`);
      },
    };
  }
}

mockDenModule("ee/apps/den-api/src/env.ts", () => ({
  env: {
    allowPrivateMcpUrls: true,
    apiPublicUrl: "http://127.0.0.1:19876",
  },
}));
mockDenModule("ee/apps/den-api/src/capability-sources/url-guard.ts", () => ({
  PrivateUrlError,
  createGuardedFetch: () => observedFetch,
  createRealmSafeFetch: () => observedFetch,
}));
mockDenModule("ee/apps/den-api/src/capability-sources/enterprise-mcp-oauth-persistence.ts", () => ({
  DenEnterpriseMcpOAuthPersistence: MockDenEnterpriseMcpOAuthPersistence,
}));
mockDenModule("ee/apps/den-api/src/capability-sources/external-mcp-client.ts", () => ({
  EXTERNAL_MCP_TOOL_CALL_TIMEOUT_MS: 120_000,
}));
mockDenModule("ee/apps/den-api/src/capability-sources/external-mcp-tool-inspection.ts", () => ({
  withExternalMcpToolCallInspection: (operation) => operation({ observeFetch: (fetchLike) => fetchLike }),
}));

const mockServerModule = await import(rootHref("packages/enterprise-mcp-mock-server/src/index.ts"));
const denAdapter = await import(rootHref("ee/apps/den-api/src/capability-sources/enterprise-mcp-client-adapter.ts"));
const denDiagnostics = await import(rootHref("ee/apps/den-api/src/capability-sources/external-mcp-diagnostics.ts"));

const {
  createEnterpriseMcpMockServer,
  createFaultScenario,
  getFaultDefinition,
  getProviderProfile,
  probeEnterpriseMcpMockServer,
} = mockServerModule;
const {
  callExternalMcpTool,
  completeExternalMcpAuth,
  connectExternalMcp,
  listExternalMcpTools,
} = denAdapter;
const {
  externalMcpDiagnosticForResponse,
  externalMcpOAuthCallbackError,
} = denDiagnostics;

function profileIdForFault(faultId) {
  return faultId === "dcr-required" ? "synthetic-enterprise-oauth-mcp" : "servicenow-inbound-quickstart";
}

function externalConnection(input) {
  return {
    id: input.connectionId,
    name: `Hostile gateway ${input.faultId}`,
    organizationId: "organization_eval_hostile_gateway",
    url: input.server.mcpUrl,
    authType: "oauth",
    credentialMode: "shared",
    apiKey: null,
    accessToken: null,
    refreshToken: null,
    tokenType: null,
    scope: null,
    expiresAt: null,
    pendingCodeVerifier: null,
    oauthConfiguration: {
      callbackMode: "isolated-v1",
      requestedScopes: input.scenario.oauth.authorizationScopes,
    },
  };
}

function seedManualRegistration(store, scenario, profile) {
  if (scenario.oauth.registration !== "manual") return;
  const tokenEndpointAuthMethod = profile.oauth.defaultClientAuthenticationMethod;
  store.registration = {
    clientInformation: {
      client_id: scenario.oauth.clientId,
      redirect_uris: scenario.oauth.redirectUris,
      token_endpoint_auth_method: tokenEndpointAuthMethod,
      ...(tokenEndpointAuthMethod === "client_secret_post" ? { client_secret: oauthClientSecret } : {}),
    },
    revision: nextRevision(store),
    source: "pre-registered",
  };
}

function seedExpiredRefreshCredential(store, scenario, profile) {
  seedManualRegistration(store, scenario, profile);
  store.credential = {
    expiresAt: Date.now() - 1_000,
    revision: nextRevision(store),
    tokens: {
      access_token: "expired-access-token",
      refresh_token: "expired-refresh-token",
      token_type: "Bearer",
    },
  };
}

function responseTextBody(value) {
  if (!value) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

async function fetchAuthorizeUrl(authorizeUrl) {
  const response = await fetch(authorizeUrl, { redirect: "manual" });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  const location = response.headers.get("location");
  const callback = location ? new URL(location) : null;
  return {
    body,
    code: callback?.searchParams.get("code") ?? null,
    location,
    state: callback?.searchParams.get("state") ?? null,
    status: response.status,
    text,
  };
}

function diagnosticFromError(error, referenceId, fallbackPhase) {
  return serializeDiagnostic(externalMcpDiagnosticForResponse(error, referenceId, fallbackPhase));
}

function callbackDiagnostic(referenceId, providerErrorCode) {
  return serializeDiagnostic(externalMcpOAuthCallbackError(referenceId, providerErrorCode).diagnostic);
}

function serializeDiagnostic(diagnostic) {
  if (!diagnostic) return null;
  return {
    actionOwner: diagnostic.actionOwner,
    category: diagnostic.category,
    code: diagnostic.code,
    highestPassed: diagnostic.highestPassed,
    httpStatus: diagnostic.httpStatus,
    message: diagnostic.message,
    operationPhase: diagnostic.operationPhase,
    operatorAction: diagnostic.operatorAction,
    outbound: diagnostic.outbound,
    phase: diagnostic.phase,
    providerCode: diagnostic.providerCode,
    providerErrorData: diagnostic.providerErrorData,
    providerErrorMessage: diagnostic.providerErrorMessage,
    providerRequestId: diagnostic.providerRequestId,
    providerStatus: diagnostic.providerStatus,
    referenceId: diagnostic.referenceId,
    retryable: diagnostic.retryable,
  };
}

function serializeConnectResult(result) {
  if (!result) return null;
  if (result.status !== "needs_auth") return { status: result.status };
  const authorizeUrl = new URL(result.authorizeUrl);
  return {
    authorizeUrl: result.authorizeUrl,
    clientId: authorizeUrl.searchParams.get("client_id"),
    redirectUri: authorizeUrl.searchParams.get("redirect_uri"),
    scope: authorizeUrl.searchParams.get("scope"),
    state: authorizeUrl.searchParams.get("state"),
    status: result.status,
  };
}

function requestCounts(server) {
  const endpoint = new URL(server.mcpUrl);
  const sameEndpointPath = (record) => {
    const target = new URL(record.url);
    return target.port === endpoint.port && target.pathname === endpoint.pathname;
  };
  return {
    dynamicRegistrations: observedRequests.filter((record) => record.body.includes('"redirect_uris"')).length,
    getMcpEndpoint: observedRequests.filter((record) => record.method === "GET" && sameEndpointPath(record)).length,
    mcpToolCalls: observedRequests.filter((record) => record.body.includes('"tools/call"')).length,
    refreshTokenRequests: observedRequests.filter((record) => record.body.includes("grant_type=refresh_token")).length,
    tokenExchangeRequests: observedRequests.filter((record) => record.body.includes("grant_type=authorization_code")).length,
    trailingDotRequests: observedRequests.filter((record) => record.url.includes("127.0.0.1.:")).length,
  };
}

function requestSample() {
  return observedRequests.map((record) => ({
    bodyKind: record.body.includes('"tools/call"')
      ? "tools/call"
      : record.body.includes("grant_type=refresh_token")
        ? "refresh_token"
        : record.body.includes("grant_type=authorization_code")
          ? "authorization_code"
          : record.body.includes('"redirect_uris"')
            ? "client_registration"
            : record.body.includes('"initialize"')
              ? "initialize"
              : record.body.includes('"tools/list"')
                ? "tools/list"
                : "other",
    method: record.method,
    url: record.url,
  }));
}

function providerErrorCodeFromBody(body) {
  return body && typeof body === "object" && !Array.isArray(body) && typeof body.error === "string"
    ? body.error
    : null;
}

function defaultArgumentValue(schema, name) {
  if (!schema || typeof schema !== "object") return null;
  if (Array.isArray(schema.oneOf)) return defaultArgumentValue(schema.oneOf[0], name);
  if (Array.isArray(schema.anyOf)) return defaultArgumentValue(schema.anyOf[0], name);
  if (schema.type === "string") return Array.isArray(schema.enum) ? schema.enum[0] ?? "synthetic-probe-value" : name === "number" ? "INC0000001" : "synthetic-probe-value";
  if (schema.type === "number" || schema.type === "integer") return typeof schema.minimum === "number" ? schema.minimum : 1;
  if (schema.type === "boolean") return true;
  if (schema.type === "null") return null;
  if (schema.type === "array") {
    const count = Math.max(1, typeof schema.minItems === "number" ? schema.minItems : 0);
    return Array.from({ length: count }, () => defaultArgumentValue(schema.items, name));
  }
  if (schema.type === "object") {
    const value = {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    const properties = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
    for (const requiredName of required) {
      value[requiredName] = defaultArgumentValue(properties[requiredName], requiredName);
    }
    return value;
  }
  return null;
}

function defaultArguments(schema) {
  const value = {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  const properties = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
  for (const name of required) {
    if (name === "approved") value[name] = true;
    else if (name === "idempotency_key") value[name] = "hostile-gateway-eval";
    else value[name] = defaultArgumentValue(properties[name], name);
  }
  return value;
}

async function completeHappyAuthorization(input) {
  const started = await connectExternalMcp(input.connection, input.redirectUri, input.state, undefined, input.referenceId);
  const connect = serializeConnectResult(started);
  if (started.status !== "needs_auth") throw new Error(`Expected needs_auth, got ${started.status}`);
  const authorization = await fetchAuthorizeUrl(started.authorizeUrl);
  if (!authorization.code) {
    throw new Error(`Authorization did not return a code: HTTP ${authorization.status} ${responseTextBody(authorization.body)}`);
  }
  await completeExternalMcpAuth(input.connection, authorization.code, input.redirectUri, undefined, input.referenceId, input.state);
  return { authorization, connect };
}

function baseFinding(input) {
  const store = storeFor(input.connection.id);
  return {
    faultId: input.faultId,
    fileReferences: input.fileReferences,
    profileId: input.profile.id,
    productSource: "Den external MCP runtime via ee/apps/den-api/src/capability-sources/enterprise-mcp-client-adapter.ts using @openwork/enterprise-mcp-client",
    requestCounts: requestCounts(input.server),
    requestSample: requestSample(),
    store: {
      authorizationCount: store.authorizationRecords.size,
      credentialPresent: Boolean(store.credential),
      invalidationReasons: store.invalidationReasons,
      registrationSource: store.registration?.source ?? null,
    },
  };
}

async function runCorroboratingProbe(faultId, profileId) {
  const scenario = createFaultScenario(profileId, faultId);
  const server = createEnterpriseMcpMockServer({ scenario, secrets: { oauthClientSecret } });
  await server.start();
  try {
    const result = await probeEnterpriseMcpMockServer({
      baseUrl: server.baseUrl,
      credentials: { clientSecret: oauthClientSecret },
      scenario,
    });
    return {
      label: "corroborating mock-server self probe; not the primary product assertion",
      ok: result.ok,
      error: result.error,
      observed: result.observed,
    };
  } finally {
    await server.stop();
  }
}

function assertion(name, passed, actual) {
  return { actual, name, passed };
}

async function runProductCase(faultId) {
  const profileId = profileIdForFault(faultId);
  const scenario = createFaultScenario(profileId, faultId);
  const profile = getProviderProfile(profileId);
  const server = createEnterpriseMcpMockServer({ scenario, secrets: { oauthClientSecret } });
  await server.start();
  try {
    const connectionId = `externalMcpConnection_eval_${faultId.replace(/-/gu, "_")}`;
    const connection = externalConnection({ connectionId, faultId, scenario, server });
    const store = storeFor(connection.id);
    const redirectUri = scenario.oauth.redirectUris[0];
    const referenceId = `hostile-${faultId}`;
    const state = `signed-state-${faultId}`;
    const fileReferences = [
      "packages/enterprise-mcp-client/src/enterprise-mcp-client.ts",
      "packages/enterprise-mcp-client/src/oauth-provider.ts",
      "ee/apps/den-api/src/capability-sources/enterprise-mcp-client-adapter.ts",
      "ee/apps/den-api/src/capability-sources/external-mcp-diagnostics.ts",
      "ee/apps/den-api/src/routes/org/mcp-connections.ts",
    ];

    if (faultId === "refresh-expired") {
      seedExpiredRefreshCredential(store, scenario, profile);
    } else {
      seedManualRegistration(store, scenario, profile);
    }

    if (faultId === "redirect-uri-whitelist" || faultId === "dcr-required") {
      const started = await connectExternalMcp(connection, redirectUri, state, undefined, referenceId);
      const connect = serializeConnectResult(started);
      const authorization = started.status === "needs_auth" ? await fetchAuthorizeUrl(started.authorizeUrl) : null;
      const providerErrorCode = providerErrorCodeFromBody(authorization?.body);
      const callback = providerErrorCode ? callbackDiagnostic(referenceId, providerErrorCode) : null;
      const finding = {
        ...baseFinding({ connection, faultId, fileReferences, profile, server }),
        actionableImmediately: faultId === "dcr-required"
          ? "Partially — OpenWork does perform dynamic registration when the provider advertises it, but an authorization-time DCR-required error still surfaces as a generic provider authorization rejection."
          : "Partially — the generated authorize URL contains the exact redirect_uri, but the Den callback diagnostic for this provider error does not include the rejected redirect URI or provider description.",
        assertions: [
          assertion("Den connect path returned a product authorize URL", connect?.status === "needs_auth", connect),
          assertion("Product authorize URL carries the exact OpenWork redirect URI", connect?.redirectUri === redirectUri, { redirectUri, productRedirectUri: connect?.redirectUri ?? null }),
          ...(faultId === "dcr-required" ? [
            assertion("Den adapter attempted dynamic client registration when metadata advertised it", requestCounts(server).dynamicRegistrations === 1 && store.registration?.source === "dynamic", {
              dynamicRegistrations: requestCounts(server).dynamicRegistrations,
              registrationSource: store.registration?.source ?? null,
            }),
          ] : []),
          assertion("Den callback route diagnostic for the provider error is the current product surface", callback?.message === "The provider rejected the authorization request before issuing a code.", callback),
        ],
        behavior: faultId === "dcr-required"
          ? "connectExternalMcp performed DCR and returned needs_auth; the provider then rejected the authorization request with dynamic_client_registration_required, which Den would map to a generic authorization rejection."
          : "connectExternalMcp returned needs_auth with the exact redirect_uri; the provider rejected that browser authorization request, and Den's callback error mapper would show a generic authorization rejection.",
        connect,
        denCallbackDiagnostic: callback,
        providerAuthorizationResponse: authorization,
        productMessage: callback?.message ?? `connectExternalMcp returned ${connect?.status ?? "unknown"}`,
      };
      return finding;
    }

    if (faultId === "method-405") {
      const started = await connectExternalMcp(connection, redirectUri, state, undefined, referenceId);
      const connect = serializeConnectResult(started);
      const counts = requestCounts(server);
      return {
        ...baseFinding({ connection, faultId, fileReferences, profile, server }),
        actionableImmediately: "No product error is produced because the real connect path does not issue GET to the MCP endpoint; it proceeds to OAuth instead.",
        assertions: [
          assertion("Den connect path still reaches OAuth", connect?.status === "needs_auth", connect),
          assertion("One real OpenWork connect action produced zero GET requests to the MCP endpoint", counts.getMcpEndpoint === 0, counts),
        ],
        behavior: "connectExternalMcp returned needs_auth; the hostile GET-only 405 behavior is latent because OpenWork's client uses POST for MCP initialize and never GETs the endpoint in this flow.",
        connect,
        productMessage: `connectExternalMcp returned ${connect?.status ?? "unknown"}; GET /mcp count ${counts.getMcpEndpoint}`,
      };
    }

    if (faultId === "per-connector-redirect") {
      const started = await connectExternalMcp(connection, redirectUri, state, undefined, referenceId);
      const connect = serializeConnectResult(started);
      if (started.status !== "needs_auth") throw new Error(`Expected needs_auth, got ${started.status}`);
      const authorization = await fetchAuthorizeUrl(started.authorizeUrl);
      let diagnostic = null;
      try {
        if (!authorization.code) throw new Error("Authorization did not return a code.");
        await completeExternalMcpAuth(connection, authorization.code, redirectUri, undefined, referenceId, state);
      } catch (error) {
        diagnostic = diagnosticFromError(error, referenceId, "AUTH_TOKEN_ACQUISITION");
      }
      return {
        ...baseFinding({ connection, faultId, fileReferences, profile, server }),
        actionableImmediately: "Partially — the product points at token exchange and says to verify redirect URI/PKCE, but it drops the provider's per-connector callback wording.",
        assertions: [
          assertion("Product callback path failed during token acquisition", diagnostic?.phase === "AUTH_TOKEN_ACQUISITION", diagnostic),
          assertion("Current product message is the generic token-exchange diagnostic", diagnostic?.message === "The authorization server rejected the code or token refresh exchange.", diagnostic),
          assertion("Current product surface does not include the provider's per-connector redirect text", !diagnostic?.message?.includes("per-connector redirect"), diagnostic?.message ?? null),
        ],
        authorization,
        behavior: "completeExternalMcpAuth reached the real token exchange and mapped the provider invalid_grant to Den's generic token-exchange diagnostic.",
        connect,
        diagnostic,
        productMessage: diagnostic?.message ?? "completeExternalMcpAuth unexpectedly succeeded",
      };
    }

    if (faultId === "refresh-expired") {
      let diagnostic = null;
      try {
        await listExternalMcpTools(connection, redirectUri, undefined, referenceId);
      } catch (error) {
        diagnostic = diagnosticFromError(error, referenceId, "CONTINUITY_REFRESH");
      }
      const counts = requestCounts(server);
      return {
        ...baseFinding({ connection, faultId, fileReferences, profile, server }),
        actionableImmediately: "Partially — the product identifies refresh continuity and asks for reconnection, but the message itself does not say the refresh token expired.",
        assertions: [
          assertion("Enterprise client attempted OAuth refresh for the expired credential", counts.refreshTokenRequests === 1, counts),
          assertion("Den diagnostic is anchored to refresh continuity", diagnostic?.phase === "CONTINUITY_REFRESH", diagnostic),
          assertion("Current product message is the generic token/refresh exchange diagnostic", diagnostic?.message === "The authorization server rejected the code or token refresh exchange.", diagnostic),
        ],
        behavior: "listExternalMcpTools loaded an expired credential, attempted a refresh_token grant, and Den mapped invalid_grant to the generic token/refresh exchange diagnostic.",
        diagnostic,
        productMessage: diagnostic?.message ?? "listExternalMcpTools unexpectedly succeeded",
      };
    }

    if (faultId === "trailing-dot-url") {
      let connect = null;
      let diagnostic = null;
      try {
        const started = await connectExternalMcp(connection, redirectUri, state, undefined, referenceId);
        connect = serializeConnectResult(started);
      } catch (error) {
        diagnostic = diagnosticFromError(error, referenceId, "AUTH_ISSUER_DISCOVERY");
      }
      const counts = requestCounts(server);
      return {
        ...baseFinding({ connection, faultId, fileReferences, profile, server }),
        actionableImmediately: "Yes for this narrow case — the real client canonicalizes the trailing-dot authority before issuer discovery and still reaches the authorization URL.",
        assertions: [
          assertion("OpenWork did not propagate a trailing-dot authority into product fetches", counts.trailingDotRequests === 0, counts),
          assertion("Current product behavior reaches authorization instead of failing discovery", connect?.status === "needs_auth" && diagnostic === null, diagnostic ?? connect),
        ],
        behavior: "connectExternalMcp received an authorization_servers value with a stray trailing dot, but the URL handling used by the real client canonicalized it before issuer discovery and returned a needs_auth authorize URL.",
        connect,
        diagnostic,
        productMessage: diagnostic?.message ?? `connectExternalMcp returned ${connect?.status ?? "unknown"}`,
      };
    }

    if (faultId === "per-user-403") {
      let diagnostic = null;
      let auth = null;
      try {
        auth = await completeHappyAuthorization({ connection, redirectUri, referenceId, state });
        await listExternalMcpTools(connection, redirectUri, undefined, referenceId);
      } catch (error) {
        diagnostic = diagnosticFromError(error, referenceId, "MCP_TOOL_DISCOVERY");
      }
      return {
        ...baseFinding({ connection, faultId, fileReferences, profile, server }),
        actionableImmediately: "Partially — it is classified as provider authorization/permissions during callback validation, but the message does not name the member subject or preserve the provider's exact 403 wording.",
        assertions: [
          assertion("Den diagnostic classifies tools/list HTTP 403 as provider authorization", diagnostic?.phase === "PROVIDER_AUTHORIZATION" && diagnostic?.code === "MCP_PROVIDER_HTTP_403", diagnostic),
          assertion("Current product message does not name the subject", !diagnostic?.message?.includes("synthetic-enterprise-user@example.invalid"), diagnostic?.message ?? null),
        ],
        authorization: auth?.authorization ?? null,
        behavior: "completeExternalMcpAuth exchanged the code, then its post-token MCP validation reached tools/list, received HTTP 403, and Den mapped it to a provider authorization diagnostic without subject-level detail.",
        connect: auth?.connect ?? null,
        diagnostic,
        productMessage: diagnostic?.message ?? "listExternalMcpTools unexpectedly succeeded",
      };
    }

    if (faultId === "duplicate-amplification") {
      const auth = await completeHappyAuthorization({ connection, redirectUri, referenceId, state });
      const tool = profile.tools.find((candidate) => candidate.kind === "read");
      if (!tool) throw new Error("Profile has no read tool for duplicate amplification check.");
      let diagnostic = null;
      try {
        await callExternalMcpTool({
          args: defaultArguments(tool.inputSchema),
          connection,
          diagnosticReferenceId: referenceId,
          redirectUri,
          toolName: tool.name,
        });
      } catch (error) {
        diagnostic = diagnosticFromError(error, referenceId, "MCP_TOOL_EXECUTION");
      }
      const counts = requestCounts(server);
      return {
        ...baseFinding({ connection, faultId, fileReferences, profile, server }),
        actionableImmediately: "No — one OpenWork tool action sends exactly one MCP tools/call, but the returned product diagnostic does not preserve the provider's duplicate-request signal.",
        assertions: [
          assertion("One user tool action produced exactly one OpenWork tools/call request", counts.mcpToolCalls === 1, counts),
          assertion("Den diagnostic reports only a generic provider tool error today", diagnostic?.phase === "PROVIDER_EXECUTION" && diagnostic?.code === "MCP_PROVIDER_TOOL_ERROR", diagnostic),
          assertion("Current product message does not mention duplicate requests", !diagnostic?.message?.includes("duplicate"), diagnostic?.message ?? null),
        ],
        authorization: auth.authorization,
        behavior: "callExternalMcpTool sent one MCP tools/call request; the mock gateway reported duplicate upstream amplification, and Den collapsed it to a generic provider tool error.",
        connect: auth.connect,
        diagnostic,
        productMessage: diagnostic?.message ?? "callExternalMcpTool unexpectedly succeeded",
        toolName: tool.name,
      };
    }

    throw new Error(`Unsupported hostile gateway fault ${faultId}`);
  } finally {
    await server.stop();
  }
}

async function main() {
  const faultId = process.argv[2] ?? "";
  const definition = getFaultDefinition(faultId);
  if (!definition) throw new Error(`Unknown fault '${faultId}'`);
  const product = await runProductCase(faultId);
  const corroboratingMockProbe = await runCorroboratingProbe(faultId, profileIdForFault(faultId));
  const failedAssertion = product.assertions.find((item) => !item.passed);
  console.log(JSON.stringify({
    ok: !failedAssertion,
    corroboratingMockProbe,
    failedAssertion: failedAssertion ?? null,
    product,
  }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
