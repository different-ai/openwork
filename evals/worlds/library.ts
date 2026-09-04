import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { app as startApp, faultProxy as startFaultProxy } from "@openwork/env";
import type { Den, MockHandle, Seed } from "@openwork/env";
import { denFetch, evalIn as rawEvalIn } from "@openwork/behaviors";
import type { DenFetchResult, DenSession } from "@openwork/behaviors";
import { allocateFreePort } from "@openwork/cdp";
import { startMockMcp } from "@openwork/labs";
import { electronProfilePaths } from "@openwork/hosts";

export const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

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

async function mintMcpSession(seed: Seed, den: Den, organizationId: string): Promise<DenSession> {
  const result = await seed.api(den.admin, "/v1/mcp/token", {
    method: "POST",
    headers: { "x-openwork-org-id": organizationId },
    body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }),
  });
  const token = stringField(result.body, "token");
  if (!result.response.ok || !token.startsWith("ow_mcp_at_")) {
    throw new Error(`Minting the MCP token failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return { ...den.admin, token };
}

function withDispose<T extends object>(value: T, dispose: () => Promise<void>): T & AsyncDisposable {
  return Object.assign(value, { [Symbol.asyncDispose]: dispose });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

function readBody(request: IncomingMessage): Promise<string> {
  request.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
    "content-type": "application/json",
  });
  response.end(JSON.stringify(body));
}

function streamChunk(model: string, delta: Record<string, unknown>, finishReason: string | null = null) {
  return {
    id: `chatcmpl-${model}`,
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function sendStream(response: ServerResponse, chunks: Record<string, unknown>[]): void {
  response.writeHead(200, {
    "cache-control": "no-cache",
    connection: "keep-alive",
    "content-type": "text/event-stream",
  });
  let delay = 200;
  for (const chunk of chunks) {
    setTimeout(() => response.write(`data: ${JSON.stringify(chunk)}\n\n`), delay);
    delay += 200;
  }
  setTimeout(() => response.end("data: [DONE]\n\n"), delay);
}

function projectedTool(payload: Record<string, unknown>, ending: string): string | null {
  for (const tool of records(payload.tools)) {
    if (!isRecord(tool.function)) continue;
    const name = tool.function.name;
    if (typeof name === "string" && name.endsWith(ending)) return name;
  }
  return null;
}

function completedToolCount(payload: Record<string, unknown>): number {
  return records(payload.messages).filter((message) => message.role === "tool").length;
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

export const connectStateExpression = `(() => {
  const port = localStorage.getItem("openwork.server.port") ?? "";
  const baseUrl = port ? "http://127.0.0.1:" + port : "";
  const token = localStorage.getItem("openwork.server.token") ?? "";
  if (!baseUrl || !token) return { ok: false, status: null, connectEnabled: null };
  const request = new XMLHttpRequest();
  request.open("GET", baseUrl + "/experimental/connect/state", false);
  request.setRequestHeader("Authorization", "Bearer " + token);
  request.send();
  const raw = JSON.parse(request.responseText || "{}");
  return { ok: request.status >= 200 && request.status < 300, status: raw?.status ?? null, connectEnabled: raw?.connectEnabled ?? null };
})()`;

export const runtimeGenerationExpression = `(async () => {
  const invokeDesktop = window.__OPENWORK_ELECTRON__?.invokeDesktop;
  if (!invokeDesktop) return { running: false, baseUrl: "", generation: null };
  const info = await invokeDesktop("openworkServerInfo");
  return {
    running: info?.running === true,
    baseUrl: String(info?.baseUrl ?? ""),
    generation: typeof info?.generation === "number" ? info.generation : null,
  };
})()`;

export const cloudHealthExpression = `(workspaceId) => {
    const port = localStorage.getItem("openwork.server.port");
    const token = localStorage.getItem("openwork.server.token");
    if (!port || !token) return { error: "missing local server credentials" };
    const request = new XMLHttpRequest();
    request.open("GET", "http://127.0.0.1:" + port + "/workspace/" + encodeURIComponent(workspaceId) + "/mcp/openwork-cloud/health?probe=1", false);
    request.setRequestHeader("Authorization", "Bearer " + token);
    request.send();
    return JSON.parse(request.responseText || "{}");
  }`;

export async function connectPolicyRuntimeRestart(seed: Seed, { place }: { place: import("@openwork/env").Place }) {
  const stamp = Date.now();
  const den = await seed.den({
    org: {
      name: "Connect Policy Convergence",
      admin: { email: `connect-policy-admin-${stamp}@openwork.test`, name: "Connect Policy Admin" },
      members: { fresh: { email: `connect-policy-member-${stamp}@openwork.test`, name: "Fresh Profile Member" } },
    },
  });
  const app = await startApp({ den, as: "fresh", place, localServerDelayMs: 5_000 });
  // TODO(primitive): seed.route
  await seed.evalIn(app, `(workspaceId) => { location.hash = "#/workspace/" + workspaceId + "/settings/general"; return true; }`, {
    args: [app.workspaceId],
  });
  return withDispose({ app }, async () => app.stop());
}

export async function clearConnectStateFiles(app: Awaited<ReturnType<typeof startApp>>): Promise<void> {
  if (!app.handle.profileDir) throw new Error("The local desktop profile directory is unavailable.");
  const paths = electronProfilePaths(app.handle.profileDir);
  const candidates = [
    `${paths.userDataDir}/openwork-dev-data/xdg/config/openwork/connect-state.json`,
    `${paths.configHome}/openwork/connect-state.json`,
    `${paths.homeDir}/.config/openwork/connect-state.json`,
  ];
  await Promise.all(candidates.map((path) => rm(path, { force: true })));
}

export async function connectStateProvenance(seed: Seed) {
  const stamp = Date.now();
  const den = await seed.den({
    org: {
      name: "Connect State Provenance",
      admin: { email: `connect-state-admin-${stamp}@openwork.test`, name: "Connect State Admin" },
      members: { fresh: { email: `connect-state-member-${stamp}@openwork.test`, name: "Fresh Profile Member" } },
    },
  });
  const app = await seed.desktop({ den, signIn: false });
  const workspace = await seed.workspace(app, seed.tmpPath("connect-state-provenance"));
  // TODO(primitive): seed.route
  await seed.evalIn(app, `(workspaceId) => { location.hash = "#/workspace/" + workspaceId + "/settings/general"; return true; }`, {
    args: [workspace.workspaceId],
  });
  return { app, member: den.members.fresh };
}

export async function preseededConnect(seed: Seed) {
  const stamp = Date.now();
  const skillName = `preseeded-connect-proof-${stamp}`;
  const connectionName = `PR3806 conn ${String(stamp).slice(-6)}`;
  const rawSourceText = `---\nname: ${skillName}\ndescription: Proves preseeded Connect skill discovery.\n---\n\nReturn the preseeded Connect proof phrase.`;
  const den = await seed.den({
    org: { name: `Preseeded Connect ${stamp}`, admin: { name: "Connect Admin" } },
    mocks: { connector: seed.mock() },
  });
  const organizationId = await activeOrganizationId(seed, den.admin);
  const createdSkill = await seed.api(den.admin, "/v1/plugins", {
    method: "POST",
    headers: { "x-openwork-org-id": organizationId },
    body: JSON.stringify({
      name: skillName,
      orgWide: true,
      components: [{ type: "skill", input: { rawSourceText } }],
    }),
  });
  const pluginId = stringField(isRecord(createdSkill.body) ? createdSkill.body.item : null, "id");
  if (createdSkill.response.status !== 201 || !pluginId) throw new Error("Could not seed the Connect skill.");
  const connection = await seed.orgConnection(den.admin, {
    name: connectionName,
    url: den.mocks.connector.mcpUrl,
    authType: "oauth",
    credentialMode: "per_member",
    access: { orgWide: true },
  });
  const mcpSession = await mintMcpSession(seed, den, organizationId);
  const app = await seed.desktop({ den, signIn: false });
  const workspace = await seed.workspace(app, seed.tmpPath("preseeded-connect"));
  // TODO(primitive): seed.route
  await seed.evalIn(app, `(workspaceId) => { location.hash = "#/workspace/" + workspaceId + "/settings/general"; return true; }`, {
    args: [workspace.workspaceId],
  });
  return {
    app,
    admin: den.admin,
    member: den.admin,
    mcpSession,
    pluginId,
    rawSourceText,
    skillName,
    nonsenseName: `no-such-capability-${stamp}`,
    connection,
    connectionName,
    workspaceId: workspace.workspaceId,
  };
}

export async function connectorBranding(seed: Seed) {
  const app = await seed.desktop({ name: "connector-tool-call-branding" });
  await seed.workspace(app, seed.tmpPath("connector-tool-call-branding"));
  await seed.session(app);
  // TODO(primitive): seed.connectorToolCall
  await seed.evalIn(app, `window.__openworkControl.execute("eval.connector_tool_call.seed")`, {
    awaitPromise: true,
    timeoutMs: 60_000,
  });
  return { app };
}

export async function connectorsQuickAdd(seed: Seed) {
  const den = await seed.den({
    org: { name: `Connectors Quick Add ${Date.now()}`, admin: { name: "Sarah" } },
    mocks: { connector: seed.mock() },
  });
  const web = await seed.web({
    den,
    signedInAs: den.admin,
    startPath: "/dashboard/mcp-connections",
    headless: true,
    viewport: { width: 1440, height: 1200 },
  });
  return { web, connector: den.mocks.connector };
}

export async function libraryConnectorDiscovery(seed: Seed) {
  const den = await seed.den({ org: { name: `Library connector discovery ${Date.now()}`, admin: { name: "Library Connector Admin" } } });
  const organizationId = await activeOrganizationId(seed, den.admin);
  const app = await seed.desktop({ den, as: "admin" });
  const workspace = await seed.workspace(app, seed.tmpPath("library-connector-discovery"));
  await app.client.send("Emulation.setDeviceMetricsOverride", {
    width: 820,
    height: 760,
    deviceScaleFactor: 1,
    mobile: false,
  });
  // TODO(primitive): seed.route
  await seed.evalIn(app, `(workspaceId) => { location.hash = "#/workspace/" + workspaceId + "/settings/general"; return true; }`, {
    args: [workspace.workspaceId],
  });
  return { app, organizationId, denWebUrl: den.ref.webUrl };
}

export async function librarySessionRestore(seed: Seed) {
  const stamp = Date.now();
  const den = await seed.den({
    org: { name: `Library session restore ${stamp}`, admin: { name: "Library Session Restore Admin" } },
  });
  const proxy = await seed.faultProxy(den);
  const proxiedDen = { ...den, ref: proxy.ref };
  const app = await seed.desktop({ den: proxiedDen, signIn: false });
  const workspace = await seed.workspace(app, seed.tmpPath("library-session-restore"));
  const skillsRoute = `/workspace/${workspace.workspaceId}/extensions/skills`;
  // TODO(primitive): seed.route
  await seed.evalIn(app, `(route) => { location.hash = route; return true; }`, { args: [`#${skillsRoute}`] });
  return {
    app,
    proxy,
    member: { ...den.admin, ...proxy.ref },
    skillsRoute,
    sessionRoute: `/workspace/${workspace.workspaceId}/session`,
  };
}

export async function libraryAdvancedRefresh(seed: Seed) {
  const den = await seed.den({
    org: { name: `Library Advanced refresh ${Date.now()}`, admin: { name: "Library Refresh Admin" } },
    mocks: { connector: seed.mock() },
  });
  const proxy = await seed.faultProxy(den);
  const app = await seed.desktop({ den: { ...den, ref: proxy.ref }, as: "admin" });
  const workspace = await seed.workspace(app, seed.tmpPath("library-advanced-refresh"));
  // TODO(primitive): seed.route
  await seed.evalIn(app, `(workspaceId) => { location.hash = "#/workspace/" + workspaceId + "/settings/general"; return true; }`, {
    args: [workspace.workspaceId],
  });
  return { app, proxy, admin: den.admin, connector: den.mocks.connector };
}

export async function libraryAuthoringRoutes(seed: Seed) {
  const stamp = Date.now();
  const skillName = `library-route-proof-${stamp}`;
  const description = `Exact Den description ${stamp}`;
  const instructions = `# Exact instructions\n\nReturn library route proof ${stamp}.`;
  const expectedSource = `---\nname: ${skillName}\ndescription: ${description}\n---\n\n${instructions}`;
  const connectionName = `Library route connection ${stamp}`;
  const den = await seed.den({
    org: { name: `Library authoring routes ${stamp}`, admin: { name: "Library Route Admin" } },
    mocks: { connector: seed.mock() },
  });
  const organizationId = await activeOrganizationId(seed, den.admin);
  const connection = await seed.orgConnection(den.admin, {
    name: connectionName,
    url: den.mocks.connector.mcpUrl,
    authType: "oauth",
    credentialMode: "per_member",
    access: { orgWide: true },
  });
  const proxy = await seed.faultProxy(den);
  const app = await seed.desktop({ den: { ...den, ref: proxy.ref }, signIn: false });
  const workspace = await seed.workspace(app, seed.tmpPath("library-authoring-routes"));
  // TODO(primitive): seed.route
  await seed.evalIn(app, `(workspaceId) => { location.hash = "#/workspace/" + workspaceId + "/extensions"; return true; }`, {
    args: [workspace.workspaceId],
  });
  const web = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/library", headless: true });
  return {
    app,
    web,
    proxy,
    member: { ...den.admin, ...proxy.ref },
    admin: den.admin,
    organizationId,
    skillName,
    description,
    instructions,
    expectedSource,
    connection,
    connectionName,
  };
}

export async function libraryConfigReadBudget(seed: Seed) {
  const app = await seed.desktop({ name: "library-config-read-budget" });
  await seed.workspace(app, repoRoot);
  // TODO(primitive): seed.networkObserver
  await seed.evalIn(app, `(() => {
    window.__opencodeConfigReads = 0;
    window.__librarySkillReads = 0;
    window.__libraryLifecycleReads = 0;
    const originalFetch = window.fetch;
    window.fetch = function (...args) {
      const target = typeof args[0] === "string" ? args[0] : args[0]?.url;
      if (typeof target === "string" && target.includes("/opencode-config")) window.__opencodeConfigReads += 1;
      if (typeof target === "string" && target.includes("/skills/browser-automation")) window.__librarySkillReads += 1;
      if (typeof target === "string" && (target.includes("/cloud-provider-sync/status") || target.includes("/opencode/config?") || target.endsWith("/mcp") || target.endsWith("/den-session"))) window.__libraryLifecycleReads += 1;
      return originalFetch.apply(this, args);
    };
    const bridge = window.__OPENWORK_ELECTRON__;
    if (bridge?.invokeDesktop) {
      const originalInvoke = bridge.invokeDesktop.bind(bridge);
      bridge.invokeDesktop = function (command, ...rest) {
        if (command === "readOpencodeConfig") window.__opencodeConfigReads += 1;
        return originalInvoke(command, ...rest);
      };
    }
    location.hash = "#/settings/general";
    return true;
  })()`);
  return { app };
}

export async function libraryMcpConnectError(seed: Seed) {
  const stamp = Date.now();
  const den = await seed.den({
    org: { name: `Library MCP connect error ${stamp}`, admin: { name: "Sarah" } },
    mocks: { connector: seed.mock({ profileId: "synthetic-enterprise-oauth-mcp" }) },
  });
  const app = await seed.desktop({ den, as: "admin" });
  const workspace = await seed.workspace(app, seed.tmpPath("library-mcp-connect-error"));
  // TODO(primitive): seed.route
  await seed.evalIn(app, `(workspaceId) => { location.hash = "#/workspace/" + workspaceId + "/settings/general"; return true; }`, {
    args: [workspace.workspaceId],
  });
  return {
    app,
    connector: den.mocks.connector,
    name: `lib-connect-err-${stamp}`,
    invalidUrl: `https://managed-mcp-${stamp}.invalid/mcp`,
    workspaceId: workspace.workspaceId,
  };
}

export async function librarySignedInStability(seed: Seed) {
  const den = await seed.den({
    org: { name: "Library Render Stability", admin: { name: "Library Admin" }, members: { member: { name: "Library Member" } } },
  });
  const app = await seed.desktop({ den, as: "member" });
  const workspace = await seed.workspace(app, repoRoot);
  // TODO(primitive): seed.networkObserver
  await seed.evalIn(app, `(workspaceId) => {
    window.__libraryStability = { requests: [], denEvents: 0, samples: [] };
    const originalFetch = window.fetch;
    window.fetch = function (...args) {
      const target = typeof args[0] === "string" ? args[0] : args[0]?.url;
      window.__libraryStability.requests.push(String(target));
      return originalFetch.apply(this, args);
    };
    window.addEventListener("openwork-den-settings-changed", () => { window.__libraryStability.denEvents += 1; });
    location.hash = "#/workspace/" + workspaceId + "/settings/general";
    return true;
  }`, { args: [workspace.workspaceId] });
  return { app };
}

export async function libraryStateTabs(seed: Seed) {
  const app = await seed.desktop({ name: "library-state-tabs" });
  await seed.workspace(app, repoRoot);
  // TODO(primitive): seed.route
  await seed.evalIn(app, `location.hash = "#/settings/general"; true`);
  return { app };
}

export async function localManagedMcp(seed: Seed) {
  const stamp = Date.now();
  const den = await seed.den({
    org: { name: `Local managed MCP OAuth ${stamp}`, admin: { name: "Sarah" } },
    mocks: { connector: seed.mock() },
  });
  const app = await seed.desktop({ den, as: "admin" });
  const workspace = await seed.workspace(app, seed.tmpPath("local-managed-mcp"));
  // TODO(primitive): seed.route
  await seed.evalIn(app, `(workspaceId) => { location.hash = "#/workspace/" + workspaceId + "/settings/general"; return true; }`, {
    args: [workspace.workspaceId],
  });
  return { app, connector: den.mocks.connector, name: `local-managed-${stamp}`, workspaceId: workspace.workspaceId };
}

const slackClientSecret = "slack-eval-client-secret-32-bytes";
export const slackScopes = [
  "search:read.public", "search:read.private", "chat:write", "channels:history", "groups:history",
  "im:history", "mpim:history", "users:read", "channels:read",
];

async function slackWorld(seed: Seed, profileId: "slack-user-mcp" | "synthetic-enterprise-oauth-mcp", label: string) {
  const den = await seed.den({
    org: { name: `${label} ${Date.now()}`, admin: { name: "Sarah" } },
    mocks: {
      connector: seed.mock(profileId === "slack-user-mcp"
        ? { profileId, oauthClientSecret: slackClientSecret }
        : { profileId }),
    },
  });
  const connector = den.mocks.connector;
  await connector.configureOAuthRedirectUris([`${den.ref.apiUrl}/v1/mcp-connections/oauth/callback`]);
  const name = `${label} ${Date.now()}`;
  const created = await seed.api(den.admin, "/v1/mcp-connections", {
    method: "POST",
    body: JSON.stringify({
      name,
      url: connector.mcpUrl,
      authType: "oauth",
      credentialMode: "shared",
      authorizationServerIssuer: connector.url,
      requestedScopes: profileId === "slack-user-mcp" ? slackScopes : ["mcp.read", "mcp.write", "offline_access"],
      ...(profileId === "slack-user-mcp" ? {
        oauthClient: {
          clientId: "enterprise-mcp-test-client",
          clientSecret: slackClientSecret,
          tokenEndpointAuthMethod: "client_secret_post",
        },
      } : {}),
      access: { orgWide: true, memberIds: [], teamIds: [] },
    }),
  });
  const connectionId = stringField(created.body, "id");
  if (!created.response.ok || !connectionId) throw new Error(`Could not create ${name}.`);
  const web = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/your-connections", headless: true });
  return { web, admin: den.admin, connector, connectionId, name };
}

export const slackReady = (seed: Seed) => slackWorld(seed, "slack-user-mcp", "Slack Style Ready");
export const slackRefreshDiagnostic = (seed: Seed) => slackWorld(seed, "slack-user-mcp", "Slack Style Refresh");
export const standardOauth = (seed: Seed) => slackWorld(seed, "synthetic-enterprise-oauth-mcp", "Standard OAuth MCP");

export const utf8Bytes = (value: string) => Buffer.byteLength(value, "utf8");

export function buildSkillMarkdown(name: string, headline: string, targetBytes: number): string {
  const sentence = "Orchestre le développement complet d'apps mobiles — idée, étude de marché, validation, croissance, déploiement. 大小阈值测试。";
  let markdown = `---\nname: ${name}\ndescription: Skill volumineux multi-octets qui prouve la limite de search_text.\n---\n\n# ${headline}\n\n`;
  while (utf8Bytes(markdown) < targetBytes) markdown += sentence;
  return markdown.trimEnd();
}

export async function largeSkill(seed: Seed) {
  const unique = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const den = await seed.den({ org: { name: `SearchText Overflow ${unique}` } });
  const organizationId = await activeOrganizationId(seed, den.admin);
  const headers = { "x-openwork-org-id": organizationId };
  const skillName = `grand-skill-multioctets-${unique}`;
  const skillV1 = buildSkillMarkdown(skillName, "Orchestrateur V1", 120_000);
  const created = await seed.api(den.admin, "/v1/config-objects", {
    method: "POST",
    headers,
    body: JSON.stringify({ type: "skill", sourceMode: "cloud", input: { rawSourceText: skillV1 } }),
    signal: AbortSignal.timeout(120_000),
  });
  const configObjectId = stringField(itemOf(created.body), "id");
  const skillV2 = buildSkillMarkdown(skillName, "Orchestrateur V2", 200_000);
  const versioned = await seed.api(den.admin, `/v1/config-objects/${encodeURIComponent(configObjectId)}/versions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ input: { rawSourceText: skillV2 }, reason: "spec: oversized multibyte update" }),
    signal: AbortSignal.timeout(120_000),
  });
  const smallName = `petit-skill-${unique}`;
  const smallBody = "Corps compact avec accents — été, déjà, très.";
  const smallSkill = `---\nname: ${smallName}\ndescription: Petit skill témoin.\n---\n\n${smallBody}`;
  const smallCreated = await seed.api(den.admin, "/v1/config-objects", {
    method: "POST",
    headers,
    body: JSON.stringify({ type: "skill", sourceMode: "cloud", input: { rawSourceText: smallSkill } }),
  });
  return {
    admin: den.admin,
    created,
    versioned,
    configObjectId,
    skillName,
    skillV1,
    skillV2,
    smallName,
    smallBody,
    smallCreated,
  };
}

async function capabilityWorld(seed: Seed, extraToolCount: number) {
  const den = await seed.den({ mocks: { connector: seed.mock({ extraToolCount }) } });
  const connection = await seed.orgConnection(den.admin, {
    name: `Capability Search ${Date.now()}`,
    url: den.mocks.connector.mcpUrl,
    authType: "oauth",
    credentialMode: "shared",
    access: { orgWide: true },
  });
  const organizationId = await activeOrganizationId(seed, den.admin);
  const mcpSession = await mintMcpSession(seed, den, organizationId);
  const web = await seed.web({
    den,
    signedInAs: den.admin,
    startPath: "/dashboard/your-connections",
    headless: true,
    viewport: { width: 1440, height: 1000 },
  });
  return { den, web, connector: den.mocks.connector, connection, mcpSession };
}

export const capabilitySearchScale = (seed: Seed) => capabilityWorld(seed, 400);

export async function capabilitySearchLatency(seed: Seed, { place }: { place: import("@openwork/env").Place }) {
  const healthy = await capabilityWorld(seed, 0);
  const flakyPort = await allocateFreePort();
  const loopback = `http://127.0.0.1:${flakyPort}`;
  const proxy = await startFaultProxy({ webUrl: loopback, apiUrl: loopback }, { place });
  const flakyMock = await startMockMcp({ port: flakyPort, issuer: proxy.ref.webUrl });
  const flaky = await seed.orgConnection(healthy.den.admin, {
    name: `Capability Search Flaky ${Date.now()}`,
    url: `${proxy.ref.webUrl}/mcp`,
    authType: "oauth",
    credentialMode: "shared",
    access: { orgWide: true },
  });
  return withDispose({ ...healthy, proxy, flakyMock, flaky }, async () => {
    await flakyMock.stop();
    await proxy[Symbol.asyncDispose]();
  });
}

export async function mockToolsListCount(mock: MockHandle): Promise<number> {
  const requests = await mock.requests();
  return requests.filter((request) => {
    const methods = Reflect.get(request, "rpcMethods");
    return Array.isArray(methods) && methods.includes("tools/list");
  }).length;
}

export async function coworkerTemplateEditor(seed: Seed) {
  const den = await seed.den({
    org: { name: "Prepared coworker team", members: { teammate: { name: "Team Member" } } },
  });
  const created = await seed.api(den.admin, "/v1/plugins", {
    method: "POST",
    body: JSON.stringify({ name: "Prepared marketing team", orgWide: true, components: [] }),
  });
  const pluginId = stringField(itemOf(created.body), "id");
  if (created.response.status !== 201 || !pluginId) throw new Error("The team plugin could not be prepared.");
  const web = await seed.web({
    den,
    signedInAs: den.admin,
    startPath: `/dashboard/plugins/${pluginId}`,
    headless: true,
    viewport: { width: 1440, height: 1400 },
  });
  return { den, web, pluginId };
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

export async function libraryView(seed: Seed) {
  const password = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
  const caseyEmail = process.env.OPENWORK_EVAL_CREATOR_EMAIL?.trim() || "casey.spec@acme.test";
  const novaEmail = process.env.OPENWORK_EVAL_MEMBER_EMAIL?.trim() || "nova.spec@acme.test";
  const den = await seed.den({
    reuseMembers: {
      casey: { email: caseyEmail, password, name: "Casey Spec" },
      nova: { email: novaEmail, password, name: "Nova Spec" },
    },
    mocks: {
      connector: seed.mock({ publicUrl: process.env.OPENWORK_EVAL_LIBRARY_MOCK_PUBLIC_URL?.trim() || undefined }),
    },
  });
  const organizationId = await activeOrganizationId(seed, den.admin);
  const stamp = Date.now();
  const connection = await seed.orgConnection(den.admin, {
    name: `Library Spec Linear ${stamp}`,
    url: den.mocks.connector.mcpUrl,
    authType: "oauth",
    credentialMode: "per_member",
    access: { orgWide: true },
  });
  const pluginName = `AAA Spec Library Plugin ${stamp}`;
  const skillName = `spec-library-${stamp}`;
  const rawSourceText = `---\nname: ${skillName}\ndescription: Proves the member library view.\n---\n\nReturn the library proof phrase.`;
  const createdPlugin = await seed.api(den.members.casey, "/v1/plugins", {
    method: "POST",
    headers: { "x-openwork-org-id": organizationId },
    body: JSON.stringify({
      name: pluginName,
      sourceRepositoryUrl: "https://github.com/anthropics/knowledge-work-plugins",
      components: [{ type: "skill", input: { rawSourceText } }],
    }),
  });
  const pluginId = stringField(isRecord(createdPlugin.body) ? createdPlugin.body.item : null, "id");
  if (!pluginId) throw new Error("Could not create the Library view plugin.");
  const org = await seed.api(den.admin, "/v1/org", { headers: { "x-openwork-org-id": organizationId } });
  const novaMember = isRecord(org.body)
    ? records(org.body.members).find((member) => isRecord(member.user) && member.user.email === novaEmail)
    : undefined;
  const novaMemberId = novaMember && typeof novaMember.id === "string" ? novaMember.id : "";
  if (!novaMemberId) throw new Error("Could not resolve Nova's organization membership.");
  const teamName = `Spec Library Provenance Team ${stamp}`;
  const createdTeam = await seed.api(den.admin, "/v1/teams", {
    method: "POST",
    headers: { "x-openwork-org-id": organizationId },
    body: JSON.stringify({ name: teamName }),
  });
  const teamId = stringField(isRecord(createdTeam.body) ? createdTeam.body.team : null, "id");
  if (!teamId) throw new Error("Could not create the Library provenance team.");
  await seed.api(den.admin, `/v1/teams/${encodeURIComponent(teamId)}`, {
    method: "PATCH",
    headers: { "x-openwork-org-id": organizationId },
    body: JSON.stringify({ memberIds: [novaMemberId] }),
  });
  for (const body of [{ orgMembershipId: novaMemberId, role: "viewer" }, { teamId, role: "viewer" }]) {
    await seed.api(den.members.casey, `/v1/plugins/${encodeURIComponent(pluginId)}/access`, {
      method: "POST",
      headers: { "x-openwork-org-id": organizationId },
      body: JSON.stringify(body),
    });
  }
  const web = await seed.web({
    den,
    signedInAs: den.members.nova,
    startPath: "/dashboard/library",
    headless: true,
    viewport: { width: 1280, height: 900 },
  });
  return withDispose({
    web,
    casey: den.members.casey,
    nova: den.members.nova,
    organizationId,
    pluginId,
    pluginName,
    connection,
    teamName,
  }, async () => {
    const headers = {
      authorization: `Bearer ${den.members.casey.token}`,
      "x-openwork-org-id": organizationId,
    };
    await denFetch(den.members.casey, `/v1/plugins/${encodeURIComponent(pluginId)}/archive`, { method: "POST", headers }).catch(() => undefined);
    await denFetch(den.admin, `/v1/teams/${encodeURIComponent(teamId)}`, { method: "DELETE", headers: { ...headers, authorization: `Bearer ${den.admin.token}` } }).catch(() => undefined);
    await denFetch(den.admin, `/v1/mcp-connections/${encodeURIComponent(connection.id)}`, { method: "DELETE", headers: { authorization: `Bearer ${den.admin.token}` } }).catch(() => undefined);
  });
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The fixture did not bind a TCP port.");
  return `http://127.0.0.1:${address.port}`;
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
  const result = await rawEvalIn(input.app, `(async () => {
    const port = localStorage.getItem("openwork.server.port");
    const token = localStorage.getItem("openwork.server.token");
    if (!port || !token) return "missing local server credentials";
    const request = async (path, init) => {
      const response = await fetch("http://127.0.0.1:" + port + path, {
        ...init,
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      });
      if (!response.ok) return path + " failed: " + response.status + " " + (await response.text()).slice(0, 500);
      return "ok";
    };
    const workspaceId = ${JSON.stringify(input.workspaceId)};
    const patched = await request("/workspace/" + encodeURIComponent(workspaceId) + "/config", {
      method: "PATCH",
      body: JSON.stringify({ opencode: {
        provider: {
          [${JSON.stringify(input.providerId)}]: {
            npm: "@ai-sdk/openai-compatible",
            name: "E2E MCP App model",
            options: { baseURL: ${JSON.stringify(`${input.fixtureUrl}/v1`)}, apiKey: "sk-e2e-fixture" },
            models: { [${JSON.stringify(input.modelId)}]: { name: "E2E MCP App model", tool_call: true } },
          },
        },
        mcp: ${JSON.stringify(input.directMcp ? {
          [input.directMcp.name]: { type: "remote", url: input.directMcp.url, enabled: true, oauth: false },
        } : {})},
      } }),
    });
    if (patched !== "ok") return patched;
    const reloaded = await request("/workspace/" + encodeURIComponent(workspaceId) + "/engine/reload", { method: "POST" });
    if (reloaded !== "ok" && !reloaded.includes("opencode_reload_timeout")) return reloaded;
    ${input.denApiUrl && input.mcpToken ? `
      const reconcile = await request("/workspace/" + encodeURIComponent(workspaceId) + "/mcp/openwork-cloud/reconcile", {
        method: "POST",
        body: JSON.stringify({
          config: {
            type: "remote",
            url: ${JSON.stringify(`${input.denApiUrl}/mcp/agent`)},
            enabled: true,
            headers: { Authorization: ${JSON.stringify(`Bearer ${input.mcpToken}`)} },
            oauth: false,
          },
          appHostAuthorization: ${JSON.stringify(input.appHostToken ? `Bearer ${input.appHostToken}` : undefined)},
          provider: ${JSON.stringify(input.providerId)},
          model: ${JSON.stringify(input.modelId)},
          trigger: "spec-primitives-migration",
        }),
      });
      if (reconcile !== "ok") return reconcile;
    ` : ""}
    const raw = localStorage.getItem("openwork.preferences");
    let preferences = {};
    try { preferences = raw ? JSON.parse(raw) : {}; } catch {}
    if (!preferences || typeof preferences !== "object" || Array.isArray(preferences)) preferences = {};
    localStorage.setItem("openwork.preferences", JSON.stringify({
      ...preferences,
      defaultModel: { providerID: ${JSON.stringify(input.providerId)}, modelID: ${JSON.stringify(input.modelId)} },
      modelVariant: null,
      providerStepCompleted: true,
    }));
    localStorage.setItem("openwork.defaultModel", ${JSON.stringify(`${input.providerId}/${input.modelId}`)});
    localStorage.removeItem("openwork.sessionModels." + workspaceId);
    return "ok";
  })()`, { awaitPromise: true, timeoutMs: 120_000 });
  if (result !== "ok") throw new Error(`Configuring the fixture model failed: ${String(result)}`);
}

async function reloadConfiguredApp(app: import("@openwork/cdp").Surface): Promise<void> {
  // TODO(primitive): seed.reloadConfiguredDesktop
  await rawEvalIn(app, "location.reload(); true").catch(() => undefined);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await rawEvalIn(app, "Boolean(window.__openworkControl)").catch(() => false) === true) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("The configured desktop control did not return after reload.");
}

export const connectionActionResourceUri = "ui://openwork/connection-action/v1/view.html";
export const connectionActionReply = "Connect your Acme Tracker account, then ask again.";

export async function connectionActionMcpApp(seed: Seed) {
  const providerId = "connection-action-mcp-app-provider";
  const modelId = "connection-action-mcp-app-model";
  const counters = { executeCalls: 0 };
  const searchQueries = ["Stripe revenue", "Stripe balance payments revenue", "list Stripe charges subscriptions invoices", "Stripe charges"];
  let realCapability = "";
  const fixture = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/v1/models") {
        sendJson(response, 200, { object: "list", data: [{ id: modelId, object: "model" }] });
        return;
      }
      if (request.method === "POST" && url.pathname.endsWith("/chat/completions")) {
        const payload: unknown = JSON.parse(await readBody(request));
        if (!isRecord(payload)) throw new Error("The provider request was not an object.");
        const completed = completedToolCount(payload);
        if (completed >= searchQueries.length + 1) {
          sendStream(response, [streamChunk(modelId, { role: "assistant" }), streamChunk(modelId, { content: connectionActionReply }), streamChunk(modelId, {}, "stop")]);
          return;
        }
        const searching = completed < searchQueries.length;
        const toolName = projectedTool(payload, searching ? "_search_capabilities" : "_execute_capability");
        if (!toolName) throw new Error("The capability gateway tool was not projected.");
        if (!searching) counters.executeCalls += 1;
        sendStream(response, [
          streamChunk(modelId, { role: "assistant" }),
          streamChunk(modelId, {
            tool_calls: [{
              index: 0,
              id: searching ? `call_search_${completed}` : "call_execute",
              type: "function",
              function: {
                name: toolName,
                arguments: JSON.stringify(searching ? { query: searchQueries[completed] } : { name: realCapability }),
              },
            }],
          }),
          streamChunk(modelId, {}, "tool_calls"),
        ]);
        return;
      }
      sendJson(response, 404, { error: { message: "not found" } });
    })().catch((error: unknown) => sendJson(response, 500, { error: String(error) }));
  });
  const fixtureUrl = await listen(fixture);
  try {
    const den = await seed.den({ org: { name: `Connection Action ${Date.now()}`, admin: { name: "Avery" } } });
    const organizationId = await activeOrganizationId(seed, den.admin);
    const connection = await seed.orgConnection(den.admin, {
      name: "Acme Tracker (E2E)",
      url: "https://acme-tracker.invalid/mcp",
      authType: "oauth",
      credentialMode: "per_member",
      access: { orgWide: true },
    });
    realCapability = `mcp:${connection.id}:list_charges`;
    const mcpSession = await mintMcpSession(seed, den, organizationId);
    const app = await seed.desktop({ name: "connection-action-mcp-app" });
    const workspace = await seed.workspace(app, seed.tmpPath("connection-action-mcp-app"));
    await configureWorkspaceModel(seed, {
      app,
      workspaceId: workspace.workspaceId,
      providerId,
      modelId,
      fixtureUrl,
      denApiUrl: den.ref.apiUrl,
      mcpToken: mcpSession.token,
    });
    await reloadConfiguredApp(app);
    await seed.session(app);
    return withDispose({ app, workspaceId: workspace.workspaceId, counters }, async () => closeServer(fixture));
  } catch (error) {
    await closeServer(fixture);
    throw error;
  }
}

export const skillCreatedResourceUri = "ui://openwork/skill-created/v1/view.html";
export const skillCreatedReply = "The beautiful tomatoes skill is ready to use.";

export async function skillCreatedMcpApp(seed: Seed) {
  const providerId = "skill-created-mcp-app-provider";
  const modelId = "skill-created-mcp-app-model";
  const counters = { createCalls: 0 };
  const fixture = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/v1/models") {
        sendJson(response, 200, { object: "list", data: [{ id: modelId, object: "model" }] });
        return;
      }
      if (request.method === "POST" && url.pathname.endsWith("/chat/completions")) {
        const payload: unknown = JSON.parse(await readBody(request));
        if (!isRecord(payload)) throw new Error("The provider request was not an object.");
        if (completedToolCount(payload) > 0) {
          sendStream(response, [streamChunk(modelId, { role: "assistant" }), streamChunk(modelId, { content: skillCreatedReply }), streamChunk(modelId, {}, "stop")]);
          return;
        }
        const toolName = projectedTool(payload, "_create_skill");
        if (!toolName) throw new Error("The create_skill tool was not projected.");
        counters.createCalls += 1;
        sendStream(response, [
          streamChunk(modelId, { role: "assistant" }),
          streamChunk(modelId, {
            tool_calls: [{
              index: 0,
              id: "call_create_beautiful_tomatoes",
              type: "function",
              function: {
                name: toolName,
                arguments: JSON.stringify({
                  pluginName: "Beautiful Tomatoes",
                  skillMarkdown: [
                    "---",
                    "name: beautiful-tomatoes",
                    "description: Use beautiful tomatoes whenever the user says go.",
                    "---",
                    "",
                    "Whenever the user says go, respond using beautiful tomatoes.",
                  ].join("\n"),
                }),
              },
            }],
          }),
          streamChunk(modelId, {}, "tool_calls"),
        ]);
        return;
      }
      sendJson(response, 404, { error: { message: "not found" } });
    })().catch((error: unknown) => sendJson(response, 500, { error: String(error) }));
  });
  const fixtureUrl = await listen(fixture);
  try {
    const den = await seed.den({ org: { name: `Skill Created App ${Date.now()}`, admin: { name: "Avery" } } });
    const organizationId = await activeOrganizationId(seed, den.admin);
    const mcpSession = await mintMcpSession(seed, den, organizationId);
    const app = await seed.desktop({ name: "skill-created-mcp-app" });
    const workspace = await seed.workspace(app, seed.tmpPath("skill-created-mcp-app"));
    await configureWorkspaceModel(seed, {
      app,
      workspaceId: workspace.workspaceId,
      providerId,
      modelId,
      fixtureUrl,
      denApiUrl: den.ref.apiUrl,
      mcpToken: mcpSession.token,
    });
    await reloadConfiguredApp(app);
    await seed.session(app);
    return withDispose({ app, admin: den.admin, organizationId, workspaceId: workspace.workspaceId, counters }, async () => closeServer(fixture));
  } catch (error) {
    await closeServer(fixture);
    throw error;
  }
}

export const inlineResourceUri = "ui://openwork/artifacts/arv_eval_card/views/avr_eval_card/index.html";
export const inlineReply = "The interactive artifact card is ready.";

export async function mcpAppInlineHost(seed: Seed) {
  const providerId = "mcp-app-inline-host-mock";
  const modelId = "mcp-app-inline-host-model";
  const saveTool = "save_artifact_view";
  const renderTool = "render_card";
  const counters = { saveCalls: 0, renderCalls: 0, resourceReads: 0 };
  const builder = await import("../../ee/apps/den-api/src/generated-artifact-view-builder.js");
  const built = await builder.buildGeneratedArtifactViewInWorker({
    reactSource: `export default function GeneratedArtifact({ data }) { return <article><h2>{data.title}</h2><p>{data.status}</p></article> }`,
    cssSource: "body{margin:0;padding:18px;color:#172554;background:#eff6ff;font-family:system-ui,sans-serif}article{border:1px solid #93c5fd;border-radius:14px;padding:18px;background:white}",
    outputSchema: { type: "object", properties: { title: { type: "string" }, status: { type: "string" } }, required: ["title", "status"] },
    title: "Quarterly plan",
    description: "Generated Artifact host acceptance fixture.",
  });
  if (!built.ok) throw new Error(`Generated Artifact build failed: ${JSON.stringify(built.diagnostics)}`);
  const rpc = (message: Record<string, unknown>): Record<string, unknown> => {
    if (message.method === "initialize") return {
      jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {}, resources: {} }, serverInfo: { name: "inline-host", version: "1" } },
    };
    if (message.method === "tools/list") return {
      jsonrpc: "2.0", id: message.id, result: { tools: [
        { name: saveTool, description: "Save artifact view", inputSchema: { type: "object", additionalProperties: false } },
        { name: renderTool, description: "Render artifact card", inputSchema: { type: "object", additionalProperties: false }, _meta: { ui: { resourceUri: inlineResourceUri } } },
      ] },
    };
    if (message.method === "resources/read") {
      counters.resourceReads += 1;
      return { jsonrpc: "2.0", id: message.id, result: { contents: [{
        uri: inlineResourceUri,
        mimeType: "text/html;profile=mcp-app",
        blob: Buffer.from(built.html, "utf8").toString("base64"),
        _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] } } },
      }] } };
    }
    if (message.method === "tools/call") {
      const params = isRecord(message.params) ? message.params : {};
      if (params.name === saveTool) {
        counters.saveCalls += 1;
        return { jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "Saved immutable Artifact view." }] } };
      }
      counters.renderCalls += 1;
      return { jsonrpc: "2.0", id: message.id, result: {
        content: [{ type: "text", text: "Quarterly plan: Ready" }],
        structuredContent: { schemaVersion: "1", artifact: { title: "Quarterly plan" }, data: { title: "Quarterly plan", status: "Ready" } },
      } };
    }
    return { jsonrpc: "2.0", id: message.id, result: {} };
  };
  const fixture = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/v1/models") {
        sendJson(response, 200, { object: "list", data: [{ id: modelId, object: "model" }] });
        return;
      }
      if (url.pathname === "/mcp" && request.method === "POST") {
        const parsed: unknown = JSON.parse(await readBody(request));
        const messages = Array.isArray(parsed) ? parsed : [parsed];
        const replies = messages.filter(isRecord).filter((message) => message.id !== undefined).map(rpc);
        sendJson(response, 200, Array.isArray(parsed) ? replies : replies[0]);
        return;
      }
      if (request.method === "POST" && url.pathname.endsWith("/chat/completions")) {
        const payload: unknown = JSON.parse(await readBody(request));
        if (!isRecord(payload)) throw new Error("The provider request was not an object.");
        const completed = completedToolCount(payload);
        if (completed >= 2) {
          sendStream(response, [streamChunk(modelId, { role: "assistant" }), streamChunk(modelId, { content: inlineReply }), streamChunk(modelId, {}, "stop")]);
          return;
        }
        const next = completed === 0 ? saveTool : renderTool;
        const toolName = projectedTool(payload, next);
        if (!toolName) throw new Error("The inline MCP tool was not projected.");
        sendStream(response, [
          streamChunk(modelId, { role: "assistant" }),
          streamChunk(modelId, { tool_calls: [{ index: 0, id: `call_${next}`, type: "function", function: { name: toolName, arguments: "{}" } }] }),
          streamChunk(modelId, {}, "tool_calls"),
        ]);
        return;
      }
      sendJson(response, 404, { error: "not_found" });
    })().catch((error: unknown) => sendJson(response, 500, { error: String(error) }));
  });
  const fixtureUrl = await listen(fixture);
  try {
    const app = await seed.desktop({ name: "mcp-app-inline-host" });
    const workspace = await seed.workspace(app, seed.tmpPath("mcp-app-inline-host"));
    await configureWorkspaceModel(seed, {
      app,
      workspaceId: workspace.workspaceId,
      providerId,
      modelId,
      fixtureUrl,
      directMcp: { name: "artifact-view", url: `${fixtureUrl}/mcp` },
    });
    await reloadConfiguredApp(app);
    await seed.session(app);
    return withDispose({ app, counters }, async () => closeServer(fixture));
  } catch (error) {
    await closeServer(fixture);
    throw error;
  }
}

export const remoteResourceUri = "ui://project-atlas/view.html";
export const remoteReply = "Project Atlas is open through its standard MCP server.";

export function rpcBody(id: number, method: string, params: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

export async function remoteMcpApps(seed: Seed) {
  const providerId = "remote-mcp-apps-provider";
  const modelId = "remote-mcp-apps-model";
  const counters = { standardMcpCalls: 0 };
  const state = { gatewayCapabilityName: "" };
  const builder = await import("../../ee/apps/den-api/src/generated-artifact-view-builder.js");
  const built = await builder.buildGeneratedArtifactViewInWorker({
    reactSource: `export default function ProjectAtlas(props) { const app = props.data || { name: "Project Atlas", status: "Connected through OpenWork Connect" }; return <main><h1>{app.name}</h1><p>{app.status}</p></main> }`,
    cssSource: "body{margin:0;padding:18px;color:#172033;background:#f5f7fb;font-family:system-ui,sans-serif}main{padding:22px;border:1px solid #dbe4f0;border-radius:16px;background:white}",
    outputSchema: { type: "object", additionalProperties: true },
    title: "Project Atlas",
    description: "A portable Remote MCP App acceptance fixture.",
  });
  if (!built.ok) throw new Error(`Project Atlas build failed: ${JSON.stringify(built.diagnostics)}`);
  const standardRpc = (message: Record<string, unknown>): Record<string, unknown> => {
    if (message.method === "initialize") return {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false }, resources: { listChanged: false }, extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } },
        serverInfo: { name: "project-atlas-connect-fixture", title: "Project Atlas Connect", version: "1.0.0", description: "A standard MCP App fixture served through OpenWork Connect." },
      },
    };
    if (message.method === "tools/list") return {
      jsonrpc: "2.0",
      id: message.id,
      result: { tools: [
        {
          name: "open_project_atlas",
          title: "Open Project Atlas",
          description: "Open the Project Atlas MCP App.",
          inputSchema: { type: "object", additionalProperties: false },
          annotations: { readOnlyHint: true, destructiveHint: false },
          _meta: { ui: { resourceUri: remoteResourceUri } },
        },
        {
          name: "search_projects",
          title: "Search projects",
          description: "Search the connected project catalog.",
          inputSchema: { type: "object", properties: { query: { type: "string" } }, additionalProperties: false },
          annotations: { readOnlyHint: true, destructiveHint: false },
          _meta: { ui: { visibility: ["app"] } },
        },
      ] },
    };
    if (message.method === "resources/list") return { jsonrpc: "2.0", id: message.id, result: { resources: [] } };
    if (message.method === "resources/templates/list") return { jsonrpc: "2.0", id: message.id, result: { resourceTemplates: [] } };
    if (message.method === "resources/read") return {
      jsonrpc: "2.0",
      id: message.id,
      result: { contents: [{
        uri: remoteResourceUri,
        mimeType: "text/html;profile=mcp-app",
        text: built.html.replace("</body>", "<!-- Portable revision Connect 1.0.0 --></body>"),
        _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true } },
      }] },
    };
    if (message.method === "tools/call") {
      counters.standardMcpCalls += 1;
      const params = isRecord(message.params) ? message.params : {};
      if (params.name === "open_project_atlas") return {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [{ type: "text", text: "Project Atlas opened." }],
          structuredContent: {
            schemaVersion: "1",
            artifact: { title: "Project Atlas", description: "A standard MCP App served through OpenWork Connect." },
            data: { name: "Project Atlas", status: "Connected through OpenWork Connect" },
          },
          _meta: { source: "project-atlas-standard-mcp" },
        },
      };
      return {
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: "Atlas project result" }], structuredContent: { projects: [{ id: "project-atlas", name: "Atlas migration", status: "on_track" }] } },
      };
    }
    return { jsonrpc: "2.0", id: message.id, result: {} };
  };
  const fixture = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/v1/models") {
        sendJson(response, 200, { object: "list", data: [{ id: modelId, object: "model" }] });
        return;
      }
      if (url.pathname === "/mcp" && request.method === "POST") {
        const parsed: unknown = JSON.parse(await readBody(request));
        const messages = Array.isArray(parsed) ? parsed : [parsed];
        const replies = messages.filter(isRecord).filter((message) => message.id !== undefined).map(standardRpc);
        sendJson(response, 200, Array.isArray(parsed) ? replies : replies[0]);
        return;
      }
      if (request.method === "POST" && url.pathname.endsWith("/chat/completions")) {
        const payload: unknown = JSON.parse(await readBody(request));
        if (!isRecord(payload)) throw new Error("The provider request was not an object.");
        const leaked = records(payload.tools).some((tool) => isRecord(tool.function)
          && typeof tool.function.name === "string"
          && (tool.function.name.includes("open_project_atlas") || tool.function.name.includes("search_projects")));
        if (leaked) throw new Error("Provider MCP tools leaked into the model tool list.");
        const completed = completedToolCount(payload);
        if (completed > 1) {
          sendStream(response, [streamChunk(modelId, { role: "assistant" }), streamChunk(modelId, { content: remoteReply }), streamChunk(modelId, {}, "stop")]);
          return;
        }
        const toolName = projectedTool(payload, completed === 0 ? "_search_capabilities" : "_execute_capability");
        if (!toolName) throw new Error("The capability gateway tools were not projected.");
        sendStream(response, [
          streamChunk(modelId, { role: "assistant" }),
          streamChunk(modelId, { tool_calls: [{
            index: 0,
            id: `call_atlas_${completed}`,
            type: "function",
            function: {
              name: toolName,
              arguments: completed === 0
                ? JSON.stringify({ query: "open Project Atlas", type: "mcp", limit: 5 })
                : JSON.stringify({ name: state.gatewayCapabilityName, body: {} }),
            },
          }] }),
          streamChunk(modelId, {}, "tool_calls"),
        ]);
        return;
      }
      sendJson(response, 404, { error: "not_found" });
    })().catch((error: unknown) => sendJson(response, 500, { error: String(error) }));
  });
  const fixtureUrl = await listen(fixture);
  const profileDir = `/tmp/openwork-remote-mcp-apps-profile-${Date.now()}`;
  try {
    const den = await seed.den({ org: { name: `Remote MCP Apps ${Date.now()}`, admin: { name: "Avery" } } });
    const organizationId = await activeOrganizationId(seed, den.admin);
    const initialConnection = await seed.orgConnection(den.admin, {
      name: "Atlas read-only projects",
      url: `${fixtureUrl}/mcp`,
      authType: "none",
      credentialMode: "shared",
      access: { orgWide: true },
    });
    const tokenResult = await seed.api(den.admin, "/v1/mcp/token", {
      method: "POST",
      headers: { "x-openwork-org-id": organizationId },
      body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }),
    });
    const mcpToken = stringField(tokenResult.body, "token");
    const appHostToken = stringField(tokenResult.body, "appHostToken");
    if (!mcpToken || !appHostToken || mcpToken === appHostToken) throw new Error("Den did not mint distinct model and App-host tokens.");
    const app = await seed.desktop({ name: "remote-mcp-apps", profileDir });
    const workspace = await seed.workspace(app, seed.tmpPath("remote-mcp-apps"));
    await configureWorkspaceModel(seed, {
      app,
      workspaceId: workspace.workspaceId,
      providerId,
      modelId,
      fixtureUrl,
      denApiUrl: den.ref.apiUrl,
      mcpToken,
      appHostToken,
    });
    await reloadConfiguredApp(app);
    const lateConnection = await seed.orgConnection(den.admin, {
      name: "Atlas added after Desktop reconcile",
      url: `${fixtureUrl}/mcp`,
      authType: "none",
      credentialMode: "shared",
      access: { orgWide: true },
    });
    state.gatewayCapabilityName = `mcp:${lateConnection.id}:open_project_atlas`;
    await seed.session(app);
    const web = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/library", headless: true });
    return withDispose({
      app,
      web,
      den,
      organizationId,
      initialConnection,
      lateConnection,
      mcpSession: { ...den.admin, token: mcpToken },
      appHostSession: { ...den.admin, token: appHostToken },
      workspaceId: workspace.workspaceId,
      profileDir,
      counters,
    }, async () => {
      await closeServer(fixture);
      await rm(profileDir, { recursive: true, force: true });
    });
  } catch (error) {
    await closeServer(fixture);
    await rm(profileDir, { recursive: true, force: true });
    throw error;
  }
}
