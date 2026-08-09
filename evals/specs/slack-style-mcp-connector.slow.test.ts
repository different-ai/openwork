import { expect } from "vitest";
import { denFetch } from "@openwork/behaviors";
import type { DenFetchResult, DenSession } from "@openwork/behaviors";
import { mcpMock, needs, server, test, unmetNeeds } from "@openwork/testkit";
import type { NeedsSpec } from "@openwork/testkit";

const requirements: NeedsSpec = {
  optIn: ["OPENWORK_EVAL_APP_SPECS"],
};
const missingRequirements = unmetNeeds(requirements, process.env);
const slackClientId = "enterprise-mcp-test-client";
const slackClientSecret = "slack-eval-client-secret-32-bytes";
const slackScopes = [
  "search:read.public",
  "search:read.private",
  "chat:write",
  "channels:history",
  "groups:history",
  "im:history",
  "mpim:history",
  "users:read",
  "channels:read",
];

function title(claim: string): string {
  return missingRequirements.length > 0
    ? `${claim} skipped — needs: ${missingRequirements.join(", ")}`
    : claim;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, key: string): string | null {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : null;
}

function booleanField(value: unknown, key: string): boolean | null {
  return isRecord(value) && typeof value[key] === "boolean" ? value[key] : null;
}

function auth(session: DenSession): Record<string, string> {
  return { authorization: `Bearer ${session.token}` };
}

async function createOAuthConnection(input: {
  admin: DenSession;
  name: string;
  url: string;
  authorizationServerIssuer: string;
  requestedScopes: readonly string[];
  oauthClient?: { clientId: string; clientSecret: string; tokenEndpointAuthMethod: "client_secret_post" };
}): Promise<{ id: string; name: string }> {
  const result = await denFetch(input.admin, "/v1/mcp-connections", {
    method: "POST",
    headers: auth(input.admin),
    body: JSON.stringify({
      name: input.name,
      url: input.url,
      authType: "oauth",
      credentialMode: "shared",
      authorizationServerIssuer: input.authorizationServerIssuer,
      requestedScopes: input.requestedScopes,
      ...(input.oauthClient ? { oauthClient: input.oauthClient } : {}),
      access: { orgWide: true, memberIds: [], teamIds: [] },
    }),
  });
  const id = stringField(result.body, "id");
  const name = stringField(result.body, "name");
  if (!result.response.ok || !id || !name) {
    throw new Error(`Creating ${input.name} failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return { id, name };
}

async function completeOAuth(admin: DenSession, connectionId: string): Promise<void> {
  const started = await denFetch(admin, `/v1/mcp-connections/${encodeURIComponent(connectionId)}/connect/start`, {
    headers: auth(admin),
    signal: AbortSignal.timeout(90_000),
  });
  const status = stringField(started.body, "status");
  const authorizeUrl = stringField(started.body, "authorizeUrl");
  if (!started.response.ok || status !== "needs_auth" || !authorizeUrl) {
    throw new Error(`Starting OAuth failed: HTTP ${started.response.status} ${started.text.slice(0, 1_000)}`);
  }
  const callback = await fetch(authorizeUrl, {
    redirect: "follow",
    signal: AbortSignal.timeout(120_000),
  });
  const callbackText = await callback.text();
  if (!callback.ok || !callbackText.toLowerCase().includes("connected")) {
    throw new Error(`OAuth callback failed: HTTP ${callback.status} ${callbackText.slice(0, 1_000)}`);
  }
}

async function manageableConnection(admin: DenSession, connectionId: string): Promise<Record<string, unknown> | null> {
  const result = await denFetch(admin, "/v1/mcp-connections?scope=manageable", { headers: auth(admin) });
  if (!result.response.ok) {
    throw new Error(`Listing connections failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  const connections = isRecord(result.body) && Array.isArray(result.body.connections)
    ? result.body.connections.filter(isRecord)
    : [];
  return connections.find((connection) => connection.id === connectionId) ?? null;
}

async function waitForConnected(admin: DenSession, connectionId: string): Promise<Record<string, unknown>> {
  await expect.poll(async () => {
    const connection = await manageableConnection(admin, connectionId);
    return Boolean(
      connection
      && booleanField(connection, "connected") === true
      && booleanField(connection, "connectedForMe") === true
      && stringField(connection, "credentialHealth") === "ready",
    );
  }, { timeout: 90_000, interval: 1_000 }).toBe(true);
  const connection = await manageableConnection(admin, connectionId);
  if (!connection) throw new Error(`Connected MCP connection ${connectionId} disappeared.`);
  return connection;
}

async function listTools(admin: DenSession, connectionId: string): Promise<DenFetchResult> {
  return denFetch(admin, `/v1/mcp-connections/${encodeURIComponent(connectionId)}/tools`, {
    headers: auth(admin),
    signal: AbortSignal.timeout(120_000),
  });
}

function toolNames(result: DenFetchResult): string[] {
  if (!isRecord(result.body) || !Array.isArray(result.body.tools)) return [];
  return result.body.tools
    .filter(isRecord)
    .flatMap((tool) => typeof tool.name === "string" ? [tool.name] : [])
    .sort();
}

test(title("a Slack-style OAuth MCP connects through strict version fallback and exposes its tools"), async ({ evidence, place }) => {
  needs(requirements);
  await using den = await server({
    place,
    org: { name: `Slack Style MCP Eval ${Date.now()}`, admin: { name: "Sarah" } },
    mocks: {
      slack: mcpMock({ profileId: "slack-user-mcp", oauthClientSecret: slackClientSecret }),
    },
  });
  const slack = den.mocks.slack;
  await slack.configureOAuthRedirectUris([`${den.ref.apiUrl}/v1/mcp-connections/oauth/callback`]);
  const connection = await createOAuthConnection({
    admin: den.admin,
    name: `Slack Style Ready ${Date.now()}`,
    url: slack.mcpUrl,
    authorizationServerIssuer: slack.url,
    requestedScopes: slackScopes,
    oauthClient: {
      clientId: slackClientId,
      clientSecret: slackClientSecret,
      tokenEndpointAuthMethod: "client_secret_post",
    },
  });

  await completeOAuth(den.admin, connection.id);
  const connected = await waitForConnected(den.admin, connection.id);
  const tools = await listTools(den.admin, connection.id);
  expect(tools.response.status).toBe(200);
  expect(toolNames(tools)).toEqual([
    "slack_search_private",
    "slack_search_public",
    "slack_send_message",
  ]);
  evidence.fact(
    "The Slack-style connection is ready and its live MCP tool catalog is available",
    `Connected: ${String(booleanField(connected, "connected"))}; credential health: ${String(stringField(connected, "credentialHealth"))}; tools: ${JSON.stringify(toolNames(tools))}.`,
    booleanField(connected, "connected") === true
      && stringField(connected, "credentialHealth") === "ready"
      && toolNames(tools).length === 3,
  );
});

test(title("Slack-style HTTP 200 token errors preserve invalid_refresh_token in Den diagnostics"), async ({ evidence, place }) => {
  needs(requirements);
  await using den = await server({
    place,
    org: { name: `Slack Refresh Diagnostic Eval ${Date.now()}`, admin: { name: "Sarah" } },
    mocks: {
      slack: mcpMock({ profileId: "slack-user-mcp", oauthClientSecret: slackClientSecret }),
    },
  });
  const slack = den.mocks.slack;
  await slack.configureOAuthRedirectUris([`${den.ref.apiUrl}/v1/mcp-connections/oauth/callback`]);
  const connection = await createOAuthConnection({
    admin: den.admin,
    name: `Slack Style Refresh ${Date.now()}`,
    url: slack.mcpUrl,
    authorizationServerIssuer: slack.url,
    requestedScopes: slackScopes,
    oauthClient: {
      clientId: slackClientId,
      clientSecret: slackClientSecret,
      tokenEndpointAuthMethod: "client_secret_post",
    },
  });
  await completeOAuth(den.admin, connection.id);
  await waitForConnected(den.admin, connection.id);
  expect((await listTools(den.admin, connection.id)).response.status).toBe(200);

  await slack.resetOAuth();
  const failed = await listTools(den.admin, connection.id);
  const diagnostic = isRecord(failed.body) && isRecord(failed.body.diagnostic)
    ? failed.body.diagnostic
    : null;
  const diagnosticMessage = diagnostic ? stringField(diagnostic, "message") : null;
  expect(failed.response.status).toBe(502);
  expect(stringField(failed.body, "error")).toBe("tool_catalog_failed");
  expect(diagnosticMessage).toContain("invalid_refresh_token");
  evidence.fact(
    "Den preserves Slack's real invalid_refresh_token error in the failed refresh diagnostic",
    `HTTP ${failed.response.status}; diagnostic: ${String(diagnosticMessage)}.`,
    failed.response.status === 502 && diagnosticMessage?.includes("invalid_refresh_token") === true,
  );
});

test(title("the standard OAuth token response path remains connected and usable"), async ({ evidence, place }) => {
  needs(requirements);
  await using den = await server({
    place,
    org: { name: `Standard MCP Regression Eval ${Date.now()}`, admin: { name: "Sarah" } },
    mocks: {
      standard: mcpMock({ profileId: "synthetic-enterprise-oauth-mcp" }),
    },
  });
  const standard = den.mocks.standard;
  const connection = await createOAuthConnection({
    admin: den.admin,
    name: `Standard OAuth MCP ${Date.now()}`,
    url: standard.mcpUrl,
    authorizationServerIssuer: standard.url,
    requestedScopes: ["mcp.read", "mcp.write", "offline_access"],
  });

  await completeOAuth(den.admin, connection.id);
  const connected = await waitForConnected(den.admin, connection.id);
  const tools = await listTools(den.admin, connection.id);
  expect(tools.response.status).toBe(200);
  expect(toolNames(tools)).toEqual(["mutate_record", "search_records"]);
  evidence.fact(
    "The unchanged standard OAuth profile still connects and lists its catalog",
    `Connected: ${String(booleanField(connected, "connected"))}; tools: ${JSON.stringify(toolNames(tools))}.`,
    booleanField(connected, "connected") === true && toolNames(tools).length === 2,
  );
});
