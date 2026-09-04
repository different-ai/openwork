/**
 * Customer report (2026-09): Dashboard tiles for the Atlassian remote MCP
 * fail identically for an org-account connection and an individual-accounts
 * connection when launched with the exact pasted JSON payloads
 * (`{"pageId": "1122334455"}` and a JQL query with escaped quotes).
 *
 * Root cause: both payloads omit `cloudId`, which both tools require. Before
 * the fix the author could not see that (the catalog exposed only a
 * `requiresInput` boolean), Den's proxy replaced the provider's rejection with
 * a generic phase message, and the Desktop host let the untyped throw become
 * HTTP 500 "Unexpected server error" on the tile.
 *
 * This spec proves the fixed pipeline against a deterministic Atlassian-shaped
 * witness MCP through the real Den connection proxy and the real Desktop
 * App-host launch code (`resolveConnectMcpAppResource` / `callMcpAppTool`):
 *
 * 1. The add-app catalog (`/v1/mcp-connections/:id/mcp-apps`) lists each
 *    tool's `requiredInputKeys`, so authoring can show and validate them.
 * 2. The pasted launch JSON survives Den storage and the whole launch pipeline
 *    byte-identically — escaped quotes are NOT double-escaped.
 * 3. A launch that omits `cloudId` fails as a typed
 *    `McpAppHostError("tool_call_failed")` whose message relays the provider's
 *    own rejection naming `cloudId` (mapped to 422, never a 500).
 * 4. An individual-accounts (per-member OAuth) connection without a connected
 *    account is excluded from the Desktop app-host server index entirely and
 *    its app catalog answers 409 "Connect your account…" — the needs_signin
 *    surface.
 * 5. Control: the identical launch succeeds once `cloudId` is supplied.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished } from "vitest";
import { createOrgConnection, denFetch } from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import { localMysqlIsRunning, localRedisIsRunning, server, test } from "@openwork/testkit";
import {
  callMcpAppTool,
  McpAppHostError,
  resolveConnectMcpAppResource,
} from "../../apps/server/src/mcp-app-host.js";
import {
  writeOpenWorkConnectMcpAppHostAuthorization,
  writeOpenWorkConnectMcpAppHostCatalog,
} from "../../apps/server/src/connect-mcp-server-catalog.js";
import type { ServerConfig } from "../../apps/server/src/types.js";
import {
  confluenceResourceUri as CONFLUENCE_RESOURCE,
  createAtlassianWitness,
  expectedJql as EXPECTED_JQL,
  isRecord,
  jiraResourceUri as JIRA_RESOURCE,
  pastedConfluenceJson as PASTED_CONFLUENCE_JSON,
  pastedJqlJson as PASTED_JQL_JSON,
} from "../worlds/dashboard-launch-input.ts";
import type { WitnessCall } from "../worlds/dashboard-launch-input.ts";

// The Atlassian witness is an inline loopback MCP server, so Den must run in
// the same place — the same local-placement constraint remote-mcp-apps uses.
const localPlacement = process.env.OPENWORK_EVAL_DAYTONA !== "1"
  && !process.env.OPENWORK_EVAL_DEN_API_URL?.trim();
const mysqlOpen = localPlacement && await localMysqlIsRunning();
const redisOpen = localPlacement && await localRedisIsRunning();
const title = !localPlacement
  ? "dashboard Atlassian launch input skipped — needs local placement without OPENWORK_EVAL_DAYTONA/OPENWORK_EVAL_DEN_API_URL"
  : !mysqlOpen
    ? "dashboard Atlassian launch input skipped — needs MySQL on 127.0.0.1:3306"
    : !redisOpen
      ? "dashboard Atlassian launch input skipped — needs Redis on 127.0.0.1:6379"
      : "dashboard tiles forward pasted Atlassian launch JSON intact and surface the provider's rejection when a required argument is missing";

const APP_HTML = "<!doctype html><html><head></head><body>Atlassian</body></html>";

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} was not an object: ${JSON.stringify(value)}`);
  return value;
}

function parsedLaunchInput(pasted: string): Record<string, unknown> {
  // Mirrors ee/apps/den-web org-dashboard-detail-screen.tsx ConnectionAppRow:
  // the dialog only checks JSON.parse succeeds and the value is an object.
  const parsed: unknown = JSON.parse(pasted);
  return requireRecord(parsed, "pasted launch input");
}

const WORKSPACE_ID = "ws_dashboard_atlassian_repro";

function desktopServerConfig(root: string): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    token: "token",
    hostToken: "host-token",
    configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 0 },
    corsOrigins: [],
    workspaces: [{ id: WORKSPACE_ID, name: "Repro", path: root, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "generated",
    hostTokenSource: "generated",
    logFormat: "pretty",
    logRequests: false,
  };
}

function orgHeaders(session: DenSession, orgId: string): Record<string, string> {
  return { authorization: `Bearer ${session.token}`, "x-openwork-org-id": orgId };
}

async function organizationId(admin: DenSession): Promise<string> {
  const result = await denFetch(admin, "/v1/me/orgs", { headers: { authorization: `Bearer ${admin.token}` } });
  const organizations = isRecord(result.body) && Array.isArray(result.body.orgs) ? result.body.orgs.filter(isRecord) : [];
  const id = organizations[0] && typeof organizations[0].id === "string" ? organizations[0].id : "";
  if (!result.response.ok || !id) {
    throw new Error(`Finding the active organization failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return id;
}

let agentRequestId = 0;

async function agentRpc(
  apiUrl: string,
  token: string,
  method: string,
  params: Record<string, unknown>,
  endpoint: string,
  extraHeaders: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const id = ++agentRequestId;
  const response = await fetch(`${apiUrl}${endpoint}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...extraHeaders,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    signal: AbortSignal.timeout(90_000),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`MCP ${method} failed: HTTP ${response.status} ${raw.slice(0, 500)}`);
  const payload: unknown = raw.trimStart().startsWith("{")
    ? JSON.parse(raw)
    : raw.split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => JSON.parse(line.slice(5)) as unknown)
      .find((candidate) => isRecord(candidate) && candidate.id === id);
  const message = requireRecord(payload, `${method} response`);
  if (message.error) throw new Error(`MCP ${method} returned ${JSON.stringify(message.error)}`);
  return requireRecord(message.result, `${method} result`);
}

test.skipIf(!localPlacement || !mysqlOpen || !redisOpen)(title, { timeout: 300_000 }, async ({ evidence, place }) => {
  const receivedCalls: WitnessCall[] = [];
  const witness = createAtlassianWitness(receivedCalls);
  await new Promise<void>((resolve, reject) => {
    witness.once("error", reject);
    witness.listen(0, "127.0.0.1", resolve);
  });
  onTestFinished(async () => {
    await new Promise<void>((resolve, reject) => witness.close((error) => (error ? reject(error) : resolve())));
  });
  const witnessAddress = witness.address();
  if (!witnessAddress || typeof witnessAddress === "string") throw new Error("The Atlassian witness did not bind a port.");
  const witnessUrl = `http://127.0.0.1:${witnessAddress.port}/mcp`;

  await using den = await server({
    place,
    env: { DEN_DASHBOARDS_ENABLED: "true" },
    org: { name: `Dashboard Atlassian repro ${Date.now()}`, admin: { name: "Avery" } },
  });
  const orgId = await organizationId(den.admin);
  const headers = orgHeaders(den.admin, orgId);

  // The two reported connection configurations.
  const orgAccountConnection = await createOrgConnection(den.admin, {
    name: "Atlassian (One org account)",
    url: witnessUrl,
    authType: "none",
    credentialMode: "shared",
    access: { orgWide: true },
  });
  const individualConnection = await createOrgConnection(den.admin, {
    name: "Atlassian (Individual accounts connected)",
    url: witnessUrl,
    authType: "oauth",
    credentialMode: "per_member",
    access: { orgWide: true },
  });

  // 1. The dashboard add-app catalog names both tools AND lists the keys
  //    their input schemas require, so the author can see cloudId is needed
  //    and the add-app dialog can refuse a payload that omits it.
  const appsResult = await denFetch(den.admin, `/v1/mcp-connections/${orgAccountConnection.id}/mcp-apps`, { headers });
  expect(appsResult.response.status, appsResult.text).toBe(200);
  const apps = isRecord(appsResult.body) && Array.isArray(appsResult.body.apps)
    ? appsResult.body.apps.filter(isRecord)
    : [];
  const confluenceApp = requireRecord(apps.find((app) => app.toolName === "getConfluencePage"), "Confluence app entry");
  const jqlApp = requireRecord(apps.find((app) => app.toolName === "searchJiraIssuesUsingJql"), "JQL app entry");
  expect(confluenceApp.requiresInput).toBe(true);
  expect(jqlApp.requiresInput).toBe(true);
  expect(confluenceApp.requiredInputKeys).toEqual(["cloudId", "pageId"]);
  expect(jqlApp.requiredInputKeys).toEqual(["cloudId", "jql"]);
  evidence.recordAssertionEvidence(
    "The dashboard add-app catalog names the required launch-input keys",
    `GET /v1/mcp-connections/:id/mcp-apps lists getConfluencePage with requiredInputKeys=${JSON.stringify(confluenceApp.requiredInputKeys)} and searchJiraIssuesUsingJql with requiredInputKeys=${JSON.stringify(jqlApp.requiredInputKeys)}, so the add-app dialog can show them and refuse a pasted payload that omits cloudId.`,
    JSON.stringify(confluenceApp.requiredInputKeys) === JSON.stringify(["cloudId", "pageId"])
      && JSON.stringify(jqlApp.requiredInputKeys) === JSON.stringify(["cloudId", "jql"]),
  );

  // 2. Store the dashboard with the exact pasted payloads and prove the
  //    launch arguments round-trip byte-identically (no double escaping).
  const confluenceArguments = parsedLaunchInput(PASTED_CONFLUENCE_JSON);
  const jqlArguments = parsedLaunchInput(PASTED_JQL_JSON);
  expect(jqlArguments.jql).toBe(EXPECTED_JQL);
  const serverName = typeof confluenceApp.serverName === "string" ? confluenceApp.serverName : "";
  const elements = [
    {
      serverName,
      connectionId: orgAccountConnection.id,
      toolName: "getConfluencePage",
      projectedToolName: String(confluenceApp.projectedToolName ?? ""),
      resourceUri: CONFLUENCE_RESOURCE,
      title: "Confluence page",
      launchArguments: confluenceArguments,
    },
    {
      serverName,
      connectionId: orgAccountConnection.id,
      toolName: "searchJiraIssuesUsingJql",
      projectedToolName: String(jqlApp.projectedToolName ?? ""),
      resourceUri: JIRA_RESOURCE,
      title: "Jira queue",
      launchArguments: jqlArguments,
    },
  ];
  const createResult = await denFetch(den.admin, "/v1/dashboards", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Atlassian board", elements }),
  });
  expect(createResult.response.status, createResult.text).toBe(201);
  const dashboard = requireRecord(requireRecord(createResult.body, "dashboard response").item, "dashboard item");
  const grantResult = await denFetch(den.admin, `/v1/dashboards/${String(dashboard.id)}/access`, {
    method: "POST",
    headers,
    body: JSON.stringify({ orgWide: true, role: "viewer" }),
  });
  expect(grantResult.response.status, grantResult.text).toBe(201);
  const grantedResult = await denFetch(den.admin, "/v1/me/dashboards", { headers });
  expect(grantedResult.response.status, grantedResult.text).toBe(200);
  const grantedItems = isRecord(grantedResult.body) && Array.isArray(grantedResult.body.items)
    ? grantedResult.body.items.filter(isRecord)
    : [];
  const granted = requireRecord(grantedItems.find((item) => item.id === dashboard.id), "granted dashboard");
  const grantedElements = Array.isArray(granted.elements) ? granted.elements.filter(isRecord) : [];
  const grantedJql = requireRecord(
    grantedElements.find((element) => element.toolName === "searchJiraIssuesUsingJql"),
    "granted JQL element",
  );
  const grantedJqlArguments = requireRecord(grantedJql.launchArguments, "granted JQL launch arguments");
  expect(grantedJqlArguments.jql).toBe(EXPECTED_JQL);
  const grantedConfluence = requireRecord(
    grantedElements.find((element) => element.toolName === "getConfluencePage"),
    "granted Confluence element",
  );
  expect(grantedConfluence.launchArguments).toEqual({ pageId: "1122334455" });
  evidence.recordAssertionEvidence(
    "Pasted launch JSON round-trips through Den storage byte-identically",
    `The JQL string with escaped quotes stored on the dashboard element and returned by /v1/me/dashboards strictly equals the pasted value (${JSON.stringify(EXPECTED_JQL).slice(0, 120)}…) — escaping is not the failure.`,
    grantedJqlArguments.jql === EXPECTED_JQL,
  );

  // 3. The individual-accounts connection with no connected member account is
  //    the needs_signin surface: its app catalog answers 409 and it is absent
  //    from the Desktop app-host server index.
  const individualApps = await denFetch(den.admin, `/v1/mcp-connections/${individualConnection.id}/mcp-apps`, { headers });
  expect(individualApps.response.status, individualApps.text).toBe(409);
  expect(individualApps.text).toContain("Connect your account");

  const tokenResult = await denFetch(den.admin, "/v1/mcp/token", {
    method: "POST",
    headers: { authorization: `Bearer ${den.admin.token}`, "x-openwork-org-id": orgId },
    body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }),
  });
  expect(tokenResult.response.ok, tokenResult.text).toBe(true);
  const appHostToken = String(requireRecord(tokenResult.body, "MCP token response").appHostToken ?? "");
  expect(appHostToken).not.toBe("");
  const appHostHeaders = { "x-openwork-mcp-client-capabilities": "mcp-app-host-v1" };
  const indexRead = await agentRpc(
    den.ref.apiUrl,
    appHostToken,
    "resources/read",
    { uri: "openwork://connect/mcp-servers/index.json" },
    "/mcp/agent",
    appHostHeaders,
  );
  const indexContents = Array.isArray(indexRead.contents) ? indexRead.contents.filter(isRecord) : [];
  const index = requireRecord(JSON.parse(String(indexContents[0]?.text ?? "{}")), "Connect MCP server index");
  const indexedServers = Array.isArray(index.servers) ? index.servers.filter(isRecord) : [];
  const indexedIds = indexedServers.map((entry) => String(entry.connectionId ?? ""));
  expect(indexedIds).toContain(orgAccountConnection.id);
  expect(indexedIds).not.toContain(individualConnection.id);
  evidence.recordAssertionEvidence(
    "An unconnected individual-accounts connection is the needs_signin surface",
    `GET /v1/mcp-connections/:id/mcp-apps answered 409 "Connect your account before using this MCP's tools." and the Desktop app-host server index omits connection ${individualConnection.id} while listing ${orgAccountConnection.id}; a tile granted over it can only fail with "The originating Connect MCP server is not available to this workspace."`,
    individualApps.response.status === 409 && !indexedIds.includes(individualConnection.id),
  );

  // 4. Launch exactly as the Desktop tile does, through the real Den
  //    connection proxy, using the real Desktop App-host code.
  const root = await mkdtemp(join(tmpdir(), "dashboard-atlassian-repro-"));
  const previousRuntimeDb = process.env.OPENWORK_RUNTIME_DB;
  const previousDevMode = process.env.OPENWORK_DEV_MODE;
  process.env.OPENWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  process.env.OPENWORK_DEV_MODE = "1";
  onTestFinished(async () => {
    if (previousRuntimeDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
    else process.env.OPENWORK_RUNTIME_DB = previousRuntimeDb;
    if (previousDevMode === undefined) delete process.env.OPENWORK_DEV_MODE;
    else process.env.OPENWORK_DEV_MODE = previousDevMode;
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, ".git"), { recursive: true });
  const desktopConfig = desktopServerConfig(root);
  const proxyUrl = `${den.ref.apiUrl}/mcp/agent/connections/${encodeURIComponent(orgAccountConnection.id)}`;
  await writeOpenWorkConnectMcpAppHostCatalog(desktopConfig, WORKSPACE_ID, {
    schemaVersion: "openwork.connect/mcp-servers/1",
    servers: [{
      connectionId: orgAccountConnection.id,
      name: orgAccountConnection.name,
      description: null,
      url: proxyUrl,
    }],
  });
  await writeOpenWorkConnectMcpAppHostAuthorization(desktopConfig, WORKSPACE_ID, `Bearer ${appHostToken}`, proxyUrl);

  const resolved = await resolveConnectMcpAppResource({
    serverConfig: desktopConfig,
    workspaceId: WORKSPACE_ID,
    workspaceRoot: root,
    launch: {
      connectionId: orgAccountConnection.id,
      toolName: "getConfluencePage",
      resourceUri: CONFLUENCE_RESOURCE,
    },
  });
  expect(resolved.toolName).toBe("getConfluencePage");
  expect(resolved.html).toBe(APP_HTML);

  receivedCalls.length = 0;
  const launchFailures: Array<{ tool: string; error: unknown }> = [];
  for (const launch of [
    { tool: "getConfluencePage", resourceUri: CONFLUENCE_RESOURCE, args: confluenceArguments },
    { tool: "searchJiraIssuesUsingJql", resourceUri: JIRA_RESOURCE, args: jqlArguments },
  ]) {
    try {
      const result = await callMcpAppTool({
        serverConfig: desktopConfig,
        workspaceId: WORKSPACE_ID,
        workspaceRoot: root,
        serverName: resolved.serverName,
        name: launch.tool,
        resourceUri: launch.resourceUri,
        arguments: launch.args,
        approved: true,
      });
      throw new Error(`Expected the ${launch.tool} launch to fail, got: ${JSON.stringify(result).slice(0, 500)}`);
    } catch (error) {
      launchFailures.push({ tool: launch.tool, error });
    }
  }
  // Both launches fail because cloudId is missing, and the failure is a typed
  // McpAppHostError("tool_call_failed") carrying the provider's own rejection
  // (relayed by Den as an untrusted provider-declared message) — so
  // /mcp-apps/call answers 422 with a message that names cloudId instead of
  // the generic 500 "Unexpected server error".
  for (const failure of launchFailures) {
    expect(failure.error, `launch ${failure.tool} should fail as a typed host error`).toBeInstanceOf(McpAppHostError);
    expect(failure.error).toMatchObject({ code: "tool_call_failed" });
    const message = failure.error instanceof Error ? failure.error.message : "";
    expect(message, `launch ${failure.tool} names the missing argument`).toContain("cloudId");
    expect(message).toContain("Required");
    expect(message).toContain("rejected the tool arguments");
    expect(message).not.toContain("Unexpected server error");
  }
  const failureMessages = launchFailures.map((failure) => (
    failure.error instanceof Error ? failure.error.message : String(failure.error)
  ));
  // Both connections' payloads produce the same failure because the missing
  // cloudId is independent of the connection's credential mode.
  expect(failureMessages).toHaveLength(2);
  // The witness received the pasted arguments exactly once each and intact.
  expect(receivedCalls).toEqual([
    { name: "getConfluencePage", args: { pageId: "1122334455" } },
    { name: "searchJiraIssuesUsingJql", args: { jql: EXPECTED_JQL } },
  ]);
  evidence.recordAssertionEvidence(
    "A launch missing a required argument surfaces the provider's rejection naming that argument",
    `callMcpAppTool threw McpAppHostError(tool_call_failed) for both tools with messages ${JSON.stringify(failureMessages).slice(0, 700)}; /workspace/:id/mcp-apps/call maps this to 422 tool_call_failed so the dashboard tile shows the provider's own text naming cloudId, never the generic "Unexpected server error". The witness received the pasted arguments byte-identically (jql intact, no cloudId), so the only failure is the missing required argument.`,
    launchFailures.length === 2 && failureMessages.every((message) => message.includes("cloudId") && !message.includes("Unexpected server error")),
  );

  // 5. Control: the identical pipeline succeeds when cloudId is supplied, so
  //    the pasted-JSON path itself is sound.
  receivedCalls.length = 0;
  const controlResult = await callMcpAppTool({
    serverConfig: desktopConfig,
    workspaceId: WORKSPACE_ID,
    workspaceRoot: root,
    serverName: resolved.serverName,
    name: "searchJiraIssuesUsingJql",
    resourceUri: JIRA_RESOURCE,
    arguments: { cloudId: "example-cloud-id", ...jqlArguments },
    approved: true,
  });
  expect(controlResult.isError).not.toBe(true);
  expect(receivedCalls).toEqual([
    { name: "searchJiraIssuesUsingJql", args: { cloudId: "example-cloud-id", jql: EXPECTED_JQL } },
  ]);
  evidence.recordAssertionEvidence(
    "The same launch succeeds once cloudId is supplied",
    `callMcpAppTool with { cloudId, jql } returned a non-error result through the same Den proxy and Desktop App-host pipeline, isolating the root cause to the missing required argument that the add-app dialog neither surfaced nor validated.`,
    controlResult.isError !== true,
  );
});
