import { browserScript, locate } from "@openwork/cdp";
import { fileURLToPath } from "node:url";
import { resolveEvalEngine } from "@openwork/env";
import type { Den, Seed } from "@openwork/env";
import { evalIn as rawEvalIn } from "@openwork/behaviors";
import type { DenFetchResult, DenSession } from "@openwork/behaviors";
import { type MockAgentWorkload } from "@openwork/labs";
import { configureProvider } from "./chat.ts";
import { browserScriptValue, runBrowserHost } from "../packages/env/src/browser-task.ts";
import { denForAppWeb, signedInAppWeb } from "./signed-in-app-web.ts";

export const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

/**
 * documentElement.clientWidth at an emulated viewport: equal to the width with overlay scrollbars (macOS), and
 * up to one classic vertical scrollbar narrower (Linux/Windows CI) when the page scrolls. Check page overflow
 * against this measured client width, not the emulated width.
 */
export function isEmulatedClientWidth(clientWidth: number, width: number): boolean {
  return clientWidth <= width && clientWidth >= width - 20;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

export function itemOf(body: unknown): Record<string, unknown> {
  if (!isRecord(body) || !isRecord(body.item)) {
    throw new Error(`Response had no item: ${JSON.stringify(body).slice(0, 300)}`);
  }
  return body.item;
}

export function stringField(value: unknown, key: string): string {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : "";
}

export function booleanField(value: unknown, key: string): boolean | null {
  return isRecord(value) && typeof value[key] === "boolean" ? value[key] : null;
}

async function activeOrganizationId(seed: Seed, session: DenSession): Promise<string> {
  const result = await seed.api(session, "/v1/me/orgs");
  const orgs = isRecord(result.body) ? records(result.body.orgs) : [];
  const id = orgs[0] && typeof orgs[0].id === "string" ? orgs[0].id : "";
  if (!result.response.ok || !id) {
    throw new Error(`Resolving the active organization failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return id;
}

export function toolJson(result: DenFetchResult): unknown {
  const payloads = result.text.split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5)) as unknown)
    .filter(isRecord);
  const rpc = payloads.find((payload) => isRecord(payload.result));
  if (!rpc || !isRecord(rpc.result)) throw new Error(`MCP response had no result: ${result.text.slice(0, 500)}`);
  const first = records(rpc.result.content)[0];
  if (!first || typeof first.text !== "string") return rpc.result;
  return JSON.parse(first.text);
}

export function rpcResult(result: DenFetchResult): Record<string, unknown> {
  const payload = result.text.split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5)) as unknown)
    .find(isRecord);
  if (!payload || !isRecord(payload.result)) {
    throw new Error(`MCP response had no result: ${result.text.slice(0, 500)}`);
  }
  return payload.result;
}

export function mcpCallBody(id: number, name: string, args: Record<string, unknown>): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  });
}

export async function connectorBranding(seed: Seed) {
  const engine = resolveEvalEngine();
  const proof = `Channel list ${crypto.randomUUID()}`;
  const prompt = "List three of my Slack channels.";
  const failurePrompt = "Read the three latest items in my Slack history.";
  const mutationPrompt = "Create a Slack note for the channel list.";
  const mutationProof = `Saved note ${crypto.randomUUID()}`;
  const toolArguments = { limit: 3 };
  const inputSchema = { type: "object", properties: { limit: { type: "integer" } }, required: ["limit"] };
  const search = (name: string) => ({ query: `Slack ${name}`, type: "mcp", limit: 1 });
  const steps = (name: string) => engine === "v2" ? [{
    tool: "execute",
    arguments: { code: `
      const found = await tools["openwork-cloud"].search_capabilities(${JSON.stringify(search(name))});
      const result = typeof found === "string" ? JSON.parse(found) : found;
      const catalog = result.matches ? result : JSON.parse(result.content[0].text);
      return await tools["openwork-cloud"].execute_capability({ name: catalog.matches[0].name, body: ${JSON.stringify(toolArguments)} });
    ` },
  }] : [
    { tool: "search_capabilities", arguments: search(name) },
    { tool: "execute_capability", arguments: { body: toolArguments }, argumentsFrom: "capability-search" },
  ];
  const { den, webPort } = await denForAppWeb(seed, {
    org: { name: "Connector tool display", admin: { name: "Connector Admin" } },
    mocks: { connector: seed.mock({
      allowUnauthenticatedMcp: true,
      tools: [
        { name: "list_channels", description: "List Slack channels", inputSchema,
          delayMs: 4_000, result: { content: [{ type: "text", text: proof }] } },
        { name: "read_history", description: "Read Slack history", inputSchema,
          delayMs: 4_000, result: { isError: true, content: [{ type: "text", text: "History lookup failed." }] } },
        { name: "create_note", description: "Create a Slack note", inputSchema,
          delayMs: 4_000, result: { content: [{ type: "text", text: mutationProof }] } },
      ],
    }) },
  });
  await seed.orgConnection(den.admin, {
    name: "Slack", url: den.mocks.connector.mcpUrl, authType: "none", credentialMode: "shared", access: { orgWide: true },
  });
  const workloads = await fetch(`${den.mocks.connector.url}/admin/agent-workloads`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ workloads: [
      { promptMarker: prompt, latestUserTurn: true, finalReply: "Listed the channels.", finalReplyFrom: "last-tool-text", steps: steps("list_channels") },
      { promptMarker: failurePrompt, latestUserTurn: true, finalReply: "The history lookup failed.", steps: steps("read_history") },
      { promptMarker: mutationPrompt, latestUserTurn: true, finalReply: "The note was created.", finalReplyFrom: "last-tool-text", steps: steps("create_note") },
    ] }),
  });
  if (!workloads.ok) throw new Error("Could not arrange connector model turns.");
  const providerId = "connector-display";
  const modelId = "connector-display-model";
  const { app, workspace } = await signedInAppWeb(seed, { name: "connector-tool-call-branding", den, webPort, workspacePath: seed.tmpPath("connector-tool-call-branding") });
  await configureProvider(seed, app, workspace.workspaceId, providerId, modelId, {
    provider: { [providerId]: {
      npm: "@ai-sdk/openai-compatible", name: "Connector display model",
      options: { baseURL: `${den.mocks.connector.url}/v1`, apiKey: "sk-connector-display-fixture" },
      models: { [modelId]: { name: "Connector display model" } },
    } },
  });
  await seed.session(app);
  return { app, den, engine, prompt, failurePrompt, mutationPrompt, mutationProof, proof };
}

export async function connectorCatalogManagement(seed: Seed) {
  const den = await seed.den({
    org: { name: `Connector Catalog ${Date.now()}`, admin: { name: "Catalog Admin" }, members: { member: { name: "Catalog Member" } } },
    mocks: { connector: seed.mock() },
  });
  const connection = await seed.orgConnection(den.admin, {
    name: "Catalog Notes",
    url: den.mocks.connector.mcpUrl,
    authType: "oauth",
    credentialMode: "per_member",
    access: { orgWide: true },
  });
  // Native OAuth clients intentionally have no managed MCP row.
  const google = await seed.api(den.admin, "/v1/oauth-providers/google-workspace/client", {
    method: "POST",
    body: JSON.stringify({ clientId: "catalog-test-client", clientSecret: "catalog-test-secret" }),
  });
  if (!google.response.ok) throw new Error("Could not arrange the native Google client.");
  // Fault the provider boundary, not Den's startup response or persisted readiness.
  const rejected = await seed.faultProxy(den);
  await rejected.faults.status("/mcp", 503, { times: 1000, body: { error: "catalog_provider_unavailable" } });
  const rejectedConnection = await seed.orgConnection(den.admin, {
    name: "Catalog Recovery",
    url: `${rejected.ref.webUrl}/mcp`,
    authType: "oauth",
    credentialMode: "per_member",
    access: { orgWide: true },
  });
  const web = await seed.web({
    den,
    signedInAs: den.admin,
    startPath: "/dashboard/mcp-connections/new",
    headless: true,
    viewport: { width: 1440, height: 1200 },
  });
  const memberWeb = await seed.web({
    den, signedInAs: den.members.member, startPath: `/dashboard/your-connections?connectionId=${connection.id}`, headless: true,
  });
  return { den, web, memberWeb, connection, rejectedConnection, connector: den.mocks.connector, rejected };
}

export async function desktopWithExternalOpenCapture(seed: Seed, den: Den, identity: string, model?: string) {
  const app = await seed.desktop({
    den, as: identity, model,
    env: { OPENWORK_DEV_MODE: "1", OPENWORK_EVAL_CAPTURE_EXTERNAL_OPENS: "1" },
  });
  const profileDir = app.handle.profileDir;
  if (!profileDir) throw new Error("The fixture desktop did not expose its profile directory.");
  const browserUrls = {
    async opened(): Promise<string[]> {
      const text = await runBrowserHost(app, `
        const { readFile } = await import("node:fs/promises");
        const { join } = await import("node:path");
        const path = join(${browserScriptValue(profileDir)}, "electron-userdata", "openwork-eval-external-opens.jsonl");
        try { return await readFile(path, "utf8"); }
        catch (error) { if (error.code === "ENOENT") return ""; throw error; }
      `);
      if (typeof text !== "string") throw new Error("External-open capture read did not return text.");
      if (!text) return [];
      if (!text.endsWith("\n")) throw new Error("External-open capture has an incomplete record.");
      return text.slice(0, -1).split("\n").map((line) => {
        const url: unknown = JSON.parse(line);
        if (typeof url !== "string") throw new Error("External-open capture contains a non-string URL.");
        return url;
      });
    },
  };
  return { app, browserUrls };
}

const paperFlowSupport = ["Alex R.", "Jordan L.", "Priya N.", "Chris M.", "Dana W."];

/**
 * The ENG-73 Library boards as one organization: Sam K. (admin) adds, shares,
 * edits, and deletes things; Support (five people, Alex among them) receives
 * what Sam shares. Connections the org already has cover the Ready and Sign in
 * rows. Den's connector catalog is served at the proxy so Slack is
 * a local OAuth MCP: Den still runs the real sign-in start against it, and no
 * real provider is called.
 */
export async function libraryPaperFlow(seed: Seed) {
  const orgName = "Paper Flow Studio";
  const prompt = "Brief me on the customer I'm meeting tomorrow at 10";
  const providerId = "paper-flow";
  const modelId = "paper-flow-model";
  const den = await seed.den({
    org: {
      name: orgName,
      admin: { name: "Sam K." },
      members: Object.fromEntries(paperFlowSupport.map((name) => [name.split(" ")[0]?.toLowerCase() ?? name, { name }])),
    },
    mocks: {
      model: seed.mock({
        allowUnauthenticatedMcp: true,
        tools: [{ name: "search_pages", description: "Search the team wiki", inputSchema: { type: "object", properties: { query: { type: "string" } } },
          result: { content: [{ type: "text", text: "No pages yet." }] } }],
        agentWorkloads: [{
          promptMarker: prompt,
          latestUserTurn: true,
          finalReply: "Here is a one-page brief for your 10:00 customer meeting.",
          steps: [
            { tool: "list_skills", arguments: { query: "customer briefing", limit: 1 } },
            { tool: "get_skill", arguments: {}, argumentsFrom: "skill-list" },
          ],
        }],
      }),
      accounts: seed.mock(),
      tracker: seed.mock(),
      slack: seed.mock(),
    },
  });
  const organizationId = await activeOrganizationId(seed, den.admin);
  const headers = { "x-openwork-org-id": organizationId };
  const org = await seed.api(den.admin, "/v1/org", { headers });
  const members = isRecord(org.body) ? records(org.body.members) : [];
  const supportIds = paperFlowSupport.map((name) => {
    const member = members.find((entry) => isRecord(entry.user) && entry.user.name === name);
    const id = member && typeof member.id === "string" ? member.id : "";
    if (!id) throw new Error(`Could not resolve ${name}'s organization membership.`);
    return id;
  });
  const createdTeam = await seed.api(den.admin, "/v1/teams", { method: "POST", headers, body: JSON.stringify({ name: "Support" }) });
  const supportTeamId = stringField(isRecord(createdTeam.body) ? createdTeam.body.team : null, "id");
  if (!supportTeamId) throw new Error("Could not create the Support team.");
  const patched = await seed.api(den.admin, `/v1/teams/${encodeURIComponent(supportTeamId)}`, {
    method: "PATCH", headers, body: JSON.stringify({ memberIds: supportIds }),
  });
  if (!patched.response.ok) throw new Error(`Could not add Support's members: HTTP ${patched.response.status}`);

  // Den seeds its starter marketplaces the first time anyone lists them, as
  // Sam. The boards show an org whose starters are out of the way, so seed and
  // archive them now; Den seeds them only once per org.
  const listedMarketplaces = await seed.api(den.admin, "/v1/marketplaces", { headers });
  if (!listedMarketplaces.response.ok) throw new Error(`Could not list marketplaces: HTTP ${listedMarketplaces.response.status}`);
  const starterIds: string[] = [];
  for (let cursor = ""; ;) {
    const page = await seed.api(den.admin, `/v1/plugins?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { headers });
    const body = isRecord(page.body) ? page.body : {};
    const items = Array.isArray(body.items) ? body.items.filter(isRecord) : [];
    starterIds.push(...items.flatMap((item) => typeof item.id === "string" ? [item.id] : []));
    const next = typeof body.nextCursor === "string" ? body.nextCursor : "";
    if (!next || items.length === 0) break;
    cursor = next;
  }
  for (const pluginId of starterIds) {
    const archived = await seed.api(den.admin, `/v1/plugins/${encodeURIComponent(pluginId)}/archive`, { method: "POST", headers, body: "{}" });
    if (!archived.response.ok) throw new Error(`Could not archive starter plugin ${pluginId}: HTTP ${archived.response.status}`);
  }

  const { model, accounts, tracker, slack } = den.mocks;
  await seed.orgConnection(den.admin, { name: "Team wiki", url: model.mcpUrl, authType: "none", credentialMode: "shared", access: { orgWide: true } });
  await seed.orgConnection(den.admin, { name: "Google Workspace", url: accounts.mcpUrl, authType: "oauth", credentialMode: "per_member", access: { orgWide: true } });
  await seed.orgConnection(den.admin, { name: "Linear", url: tracker.mcpUrl, authType: "oauth", credentialMode: "per_member", access: { orgWide: true } });

  const presets = [
    { presetId: "slack", displayName: "Slack", description: "Messages and channels. Each person signs in with their own Slack.", url: slack.mcpUrl, authType: "oauth" },
    { presetId: "notion", displayName: "Notion", description: "Pages and databases.", url: "https://notion.connector.test/mcp", authType: "oauth" },
    { presetId: "github", displayName: "GitHub", description: "Issues and pull requests.", url: "https://github.connector.test/mcp", authType: "oauth" },
    { presetId: "microsoft-365", displayName: "Microsoft 365", description: "Mail, calendar and files.", url: "https://m365.connector.test/mcp", authType: "oauth" },
    { presetId: "linear", displayName: "Linear", description: "Issues and projects.", url: tracker.mcpUrl, authType: "oauth" },
  ];
  const proxy = await seed.faultProxy(den);
  await proxy.faults.status("/api/runtime-config", 200, { times: 1000, body: { denApiUrl: proxy.ref.apiUrl } });
  for (const path of ["/api/den/v1/mcp-connections/presets", "/v1/mcp-connections/presets"]) {
    await proxy.faults.status(path, 200, { times: 1000, body: { presets } });
  }
  // What Den reports for a server that signs in with an account and registers itself; no provider is contacted.
  const discovery = {
    status: "ready",
    server: { url: slack.mcpUrl, protocolVersion: "2025-06-18", initialize: "authentication_required" },
    authentication: { kind: "oauth", availableRegistrationMethods: ["dynamic", "client_metadata"], recommendedRegistrationMethod: "client_metadata" },
    tools: { visibility: "requires_auth" },
    manualRequirements: [],
  };
  for (const path of ["/api/den/v1/mcp-connections/discover", "/v1/mcp-connections/discover"]) {
    await proxy.faults.status(path, 200, { times: 1000, body: discovery });
  }
  const shapedDen = { ...den, ref: proxy.ref };
  const viewport = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false };

  const signedOut = await seed.desktop({ den: shapedDen, signIn: false });
  const signedOutWorkspace = await seed.workspace(signedOut, seed.tmpPath("library-paper-flow-signed-out"), { create: true });
  await signedOut.client.send("Emulation.setDeviceMetricsOverride", viewport);
  // TODO(primitive): seed.route
  await seed.evalIn(signedOut, browserScript((workspaceId) => { location.hash = "#/workspace/" + workspaceId + "/extensions"; return true; }, [signedOutWorkspace.workspaceId]));

  const { app, browserUrls } = await desktopWithExternalOpenCapture(seed, shapedDen, "admin", `${providerId}/${modelId}`);
  // Keep repository-local skills out of this Library.
  const workspace = await seed.workspace(app, seed.tmpPath("library-paper-flow"), { create: true });
  const providerConfig = {
    provider: { [providerId]: {
      npm: "@ai-sdk/openai-compatible", name: "Paper flow model",
      options: { baseURL: `${model.url}/v1`, apiKey: "sk-paper-flow-fixture" },
      models: { [modelId]: { name: "Paper flow model", tool_call: true } },
    } },
  };
  // A fresh workspace's engine can still be starting when the first reload lands.
  for (let attempt = 1; ; attempt += 1) {
    try {
      await configureProvider(seed, app, workspace.workspaceId, providerId, modelId, providerConfig);
      break;
    } catch (error) {
      if (attempt >= 4 || !String(error).includes("opencode_engine_unreachable")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }
  await app.client.send("Emulation.setDeviceMetricsOverride", viewport);
  // TODO(primitive): seed.route
  await seed.evalIn(app, browserScript((workspaceId) => { location.hash = "#/workspace/" + workspaceId + "/extensions"; return true; }, [workspace.workspaceId]));

  const alexApp = await seed.desktop({ den: shapedDen, as: "alex" });
  const alexWorkspace = await seed.workspace(alexApp, seed.tmpPath("library-paper-flow-alex"), { create: true });
  await alexApp.client.send("Emulation.setDeviceMetricsOverride", viewport);
  // TODO(primitive): seed.route
  await seed.evalIn(alexApp, browserScript((workspaceId) => { location.hash = "#/workspace/" + workspaceId + "/extensions"; return true; }, [alexWorkspace.workspaceId]));
  return {
    app,
    signedOut,
    alexApp,
    browserUrls,
    orgName,
    prompt,
    organizationId,
    alex: den.members.alex,
    slackMcpUrl: slack.mcpUrl,
    slackOrigin: new URL(slack.url).origin,
    supportSize: paperFlowSupport.length,
  };
}

export const utf8Bytes = (value: string) => Buffer.byteLength(value, "utf8");

export function buildSkillMarkdown(name: string, headline: string, targetBytes: number): string {
  const sentence = "Orchestre le développement complet d'apps mobiles — idée, étude de marché, validation, croissance, déploiement. 大小阈值测试。";
  let markdown = `---\nname: ${name}\ndescription: Skill volumineux multi-octets qui prouve la limite de search_text.\n---\n\n# ${headline}\n\n`;
  while (utf8Bytes(markdown) < targetBytes) markdown += sentence;
  return markdown.trimEnd();
}

export async function pluginEditorWithConnector(seed: Seed) {
  const stamp = Date.now();
  const den = await seed.den({
    org: { name: `Plugin from connector ${stamp}`, admin: { name: "Plugin Admin" } },
    mocks: { crm: seed.mock({ allowUnauthenticatedMcp: true }) },
  });
  const connection = await seed.orgConnection(den.admin, {
    name: `CRM connector ${stamp}`,
    url: den.mocks.crm.mcpUrl,
    authType: "none",
    credentialMode: "shared",
    access: { orgWide: true },
  });
  const marketplaceName = `Sales collection ${stamp}`;
  const createdMarketplace = await seed.api(den.admin, "/v1/marketplaces", {
    method: "POST",
    body: JSON.stringify({ name: marketplaceName }),
  });
  const marketplaceId = stringField(isRecord(createdMarketplace.body) ? createdMarketplace.body.item : null, "id");
  if (createdMarketplace.response.status !== 201 || !marketplaceId) {
    throw new Error(`Creating the collection failed: HTTP ${createdMarketplace.response.status} ${createdMarketplace.text.slice(0, 500)}`);
  }

  const web = await seed.web({
    den,
    signedInAs: den.admin,
    startPath: `/dashboard/plugins/new?marketplaceId=${marketplaceId}`,
    headless: true,
    viewport: { width: 1440, height: 1100 },
  });

  return {
    den,
    web,
    connection,
    marketplaceId,
    marketplaceName,
    pluginName: `Sales CRM ${stamp}`,
  };
}

async function configureWorkspaceModel(seed: Seed, input: {
  app: import("@openwork/cdp").Surface;
  workspaceId: string;
  providerId: string;
  modelId: string;
  fixtureUrl: string;
  denApiUrl?: string;
  mcpToken?: string;
  appHostToken?: string;
  directMcp?: { name: string; url: string };
}): Promise<void> {
  // TODO(primitive): seed.workspaceRuntimeConfig
  const result = await rawEvalIn(input.app, browserScript(async (inputWorkspaceId, providerId, value, modelId, inputValue, inputValue2, inputProviderId, inputModelId, inputValue3) => {
    const port = localStorage.getItem("openwork.server.port");
    const token = localStorage.getItem("openwork.server.token");
    if (!port || !token) return "missing local server credentials";
    const request = async (path: string, init?: RequestInit) => {
      const response = await fetch("http://127.0.0.1:" + port + path, {
        ...init,
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      });
      if (!response.ok) return path + " failed: " + response.status + " " + (await response.text()).slice(0, 500);
      return "ok";
    };
    const workspaceId = inputWorkspaceId;
    const patched = await request("/workspace/" + encodeURIComponent(workspaceId) + "/config", {
      method: "PATCH",
      body: JSON.stringify({ opencode: {
        provider: {
          [providerId]: {
            npm: "@ai-sdk/openai-compatible",
            name: "E2E MCP App model",
            options: { baseURL: value, apiKey: "sk-e2e-fixture" },
            models: { [modelId]: { name: "E2E MCP App model", tool_call: true } },
          },
        },
        mcp: inputValue,
      } }),
    });
    if (patched !== "ok") return patched;
    const reloaded = await request("/workspace/" + encodeURIComponent(workspaceId) + "/engine/reload", { method: "POST" });
    if (reloaded !== "ok" && !reloaded.includes("opencode_reload_timeout") && !reloaded.includes("opencode_engine_unreachable")) return reloaded;
    if (inputValue2) {
      const reconcile = await request("/workspace/" + encodeURIComponent(workspaceId) + "/mcp/openwork-cloud/reconcile", {
        method: "POST", body: JSON.stringify(inputValue2),
      });
      if (reconcile !== "ok") return reconcile;
    }
    const deadline = Date.now() + 90_000;
    let healthy = false;
    while (Date.now() < deadline) {
      try {
        const health = await fetch("http://127.0.0.1:" + port + "/workspace/" + encodeURIComponent(workspaceId) + "/opencode/global/health", {
          headers: { Authorization: "Bearer " + token }, signal: AbortSignal.timeout(5_000),
        });
        if (health.ok) {
          const readiness: unknown = await health.json();
          if (readiness && typeof readiness === "object" && "healthy" in readiness && readiness.healthy === true) {
            healthy = true;
            break;
          }
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!healthy) return "Engine did not report healthy";
    const raw = localStorage.getItem("openwork.preferences");
    let preferences: Record<string, unknown> = {};
    try { preferences = raw ? JSON.parse(raw) : {}; } catch {}
    if (!preferences || typeof preferences !== "object" || Array.isArray(preferences)) preferences = {};
    localStorage.setItem("openwork.preferences", JSON.stringify({
      ...preferences,
      defaultModel: { providerID: inputProviderId, modelID: inputModelId },
      modelVariant: null,
      providerStepCompleted: true,
    }));
    localStorage.setItem("openwork.defaultModel", inputValue3);
    localStorage.removeItem("openwork.sessionModels." + workspaceId);
    return "ok";
  }, [input.workspaceId, input.providerId, `${input.fixtureUrl}/v1`, input.modelId, input.directMcp ? {
          [input.directMcp.name]: { type: "remote", url: input.directMcp.url, enabled: true, oauth: false },
        } : {}, input.denApiUrl && input.mcpToken ? {
      config: {
        type: "remote", url: `${input.denApiUrl}/mcp/agent`, enabled: true,
        headers: { Authorization: `Bearer ${input.mcpToken}` }, oauth: false,
      },
      appHostAuthorization: input.appHostToken ? `Bearer ${input.appHostToken}` : undefined,
      provider: input.providerId, model: input.modelId, trigger: "spec-primitives-migration",
    } : null, input.providerId, input.modelId, `${input.providerId}/${input.modelId}`]), { awaitPromise: true, timeoutMs: 120_000 });
  if (result !== "ok") throw new Error(`Configuring the fixture model failed: ${String(result)}`);
}

async function reloadConfiguredApp(app: import("@openwork/cdp").Surface): Promise<void> {
  // TODO(primitive): seed.reloadConfiguredDesktop
  await rawEvalIn(app, () => { location.reload(); return true; }).catch(() => undefined);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await rawEvalIn(app, () => (Boolean(window.__openworkControl))).catch(() => false) === true) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("The configured desktop control did not return after reload.");
}

export const connectionActionQuestion = {
  header: "Connection",
  question: "Connect Notion to continue?",
  options: [
    { label: "Authenticate", description: "Connect this account to continue." },
    { label: "Skip", description: "Continue without this connection." },
  ],
  multiple: false,
  custom: false,
};
export const connectionActionSkipPrompt = "Skip Notion setup if I choose.";
export const connectionStatusSkipPrompt = "Recheck Notion sign-in and skip if I choose.";
export const ordinaryDiscoveryPrompt = "Create a dashboard using my notes.";
export const ordinaryDiscoveryReply = "I found the available capabilities for the dashboard.";
export const connectionActionPrompt = "I want to connect Notion.";
export const connectionStatusPrompt = "Check my Notion connection so I can sign in.";

export const allConnectorsPrompt = "Show me all the quick-add connectors.";
export const allConnectorsReply = "Here are all the connectors available to add.";
export const connectorCatalogPrompt = "I want to set up Slack.";
export const connectorCatalogReply = "Slack setup options are available in your organization Connections dashboard.";

export async function connectionActionMcpApp(seed: Seed) {
  const providerId = "connection-action-mcp-app-provider";
  const modelId = "connection-action-mcp-app-model";
  const den = await seed.den({
    org: { name: `Connection Action ${Date.now()}`, admin: { name: "Connection Admin" } },
    mocks: {
      connector: seed.mock({ agentWorkloads: [{
        promptMarker: ordinaryDiscoveryPrompt,
        latestUserTurn: true,
        finalReply: ordinaryDiscoveryReply,
        steps: [{ tool: "search_capabilities", arguments: { query: "Notion", type: "mcp" } }],
      }, ...[connectionActionPrompt, connectionActionSkipPrompt].map((promptMarker): MockAgentWorkload => ({
        promptMarker,
        latestUserTurn: true,
        finalReply: "No connection outcome was observed.",
        finalReplyFrom: "last-tool-text",
        steps: [
          { tool: "search_capabilities", arguments: { query: "Notion", type: "mcp", intent: "connect" } },
          { tool: "question", arguments: { questions: [connectionActionQuestion] } },
        ],
      })), ...[connectionStatusPrompt, connectionStatusSkipPrompt].map((promptMarker): MockAgentWorkload => ({
        promptMarker,
        latestUserTurn: true,
        finalReply: "No connection outcome was observed.",
        finalReplyFrom: "last-tool-text",
        steps: [
          { tool: "search_capabilities", arguments: { query: "Notion", type: "mcp", limit: 1 } },
          { tool: "execute_capability", arguments: {}, argumentsFrom: "capability-search" },
          { tool: "question", arguments: { questions: [connectionActionQuestion] } },
        ],
      })), {
        promptMarker: connectorCatalogPrompt,
        latestUserTurn: true,
        finalReply: connectorCatalogReply,
        steps: [{ tool: "search_capabilities", arguments: { query: "Slack", type: "mcp", intent: "connect" } }],
      }, {
        promptMarker: allConnectorsPrompt,
        latestUserTurn: true,
        finalReply: allConnectorsReply,
        steps: [{ tool: "search_capabilities", arguments: { query: "quick add connectors", type: "connectors" } }],
      }] }),
    },
  });
  const organizationId = await activeOrganizationId(seed, den.admin);
  const connection = await seed.orgConnection(den.admin, {
    name: "Notion",
    url: den.mocks.connector.mcpUrl,
    authType: "oauth",
    credentialMode: "per_member",
    access: { orgWide: true },
  });
  const tokenResult = await seed.api(den.admin, "/v1/mcp/token", {
    method: "POST",
    headers: { "x-openwork-org-id": organizationId },
    body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }),
  });
  const mcpToken = stringField(tokenResult.body, "token");
  const appHostToken = stringField(tokenResult.body, "appHostToken");
  if (!mcpToken || !appHostToken || mcpToken === appHostToken) throw new Error("Distinct model and app-host tokens were not minted.");
  const app = await seed.desktop({ den, as: "admin", name: "connection-action-mcp-app" });
  const workspace = await seed.workspace(app, seed.tmpPath("connection-action-mcp-app"));
  const questionPolicyWritten = await seed.evalIn(app, browserScript(async (workspaceId) => {
    const port = localStorage.getItem("openwork.server.port");
    const token = localStorage.getItem("openwork.server.token");
    const response = await fetch("http://127.0.0.1:" + port + "/workspace/" + encodeURIComponent(workspaceId) + "/files/content", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ path: "opencode.json", content: JSON.stringify({ permission: { question: "allow" } }) }),
    });
    return response.ok;
  }, [workspace.workspaceId]), { awaitPromise: true });
  if (questionPolicyWritten !== true) throw new Error("Could not arrange the connection question-tool policy.");
  await configureWorkspaceModel(seed, {
    app, workspaceId: workspace.workspaceId, providerId, modelId,
    fixtureUrl: den.mocks.connector.url, denApiUrl: den.ref.apiUrl, mcpToken, appHostToken,
  });
  await reloadConfiguredApp(app);
  let session: { sessionId: string; title: string } | undefined;
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      session = await seed.session(app);
      break;
    } catch (error) {
      lastError = error;
      if (!String(error).includes("session ID")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  if (!session) throw lastError instanceof Error ? lastError : new Error(String(lastError));
  const connectionAppHeading = async () => (await locate(app, {
    mcpApp: { resourceUri: "ui://openwork/connection-action/v2/view.html" }, role: "heading",
  })).text;
  return { app, den, connection, organizationId, workspace, session, connectionAppHeading, mcpSession: { ...den.admin, token: mcpToken }, appHostSession: { ...den.admin, token: appHostToken } };
}

export async function connectorCatalogDiscovery(seed: Seed) {
  const world = await connectionActionMcpApp(seed);
  const response = await seed.api(world.den.admin, "/v1/mcp-connections/presets");
  if (!isRecord(response.body) || !Array.isArray(response.body.presets)) throw new Error("Den did not return its connector presets.");
  const presetIds = response.body.presets.map((preset: unknown) => {
    if (!isRecord(preset) || typeof preset.presetId !== "string") throw new Error("Invalid connector preset.");
    return preset.presetId;
  });
  const web = await seed.web({ den: world.den, signedInAs: world.den.admin, startPath: "/dashboard/mcp-connections", headless: true });
  return { ...world, web, expectedIds: ["google-workspace", "microsoft-365", ...presetIds] };
}
