import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Den, Seed } from "@openwork/env";
import { evalIn as rawEvalIn } from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";

/**
 * A managed Dashboard whose two tiles launch an Atlassian-shaped MCP with
 * launch input that omits the required `cloudId` argument — the reported
 * failure shape. The witness MCP mirrors the Atlassian remote MCP: same tool
 * names, `cloudId` required, read-only annotations, MCP-App `ui://` bindings,
 * and a JSON-RPC -32602 rejection when `cloudId` is missing.
 *
 * Payloads are anonymized, structure-identical stand-ins for the reported
 * ones (a Confluence page id and a JQL string with escaped quotes).
 */

export const confluenceResourceUri = "ui://atlassian/confluence-page/view.html";
export const jiraResourceUri = "ui://atlassian/jql-search/view.html";
export const confluenceTileTitle = "Confluence page";
export const jiraTileTitle = "Jira queue";
export const pastedConfluenceJson = `{"pageId": "1122334455"}`;
export const pastedJqlJson = `{ "jql": "project = HELPDESK AND status NOT IN (\\"Closed\\", \\"Resolved\\", \\"Duplicate\\", \\"Declined\\", \\"Spam\\") AND assignee = currentUser() ORDER BY updated ASC" }`;
export const expectedJql = 'project = HELPDESK AND status NOT IN ("Closed", "Resolved", "Duplicate", "Declined", "Spam") AND assignee = currentUser() ORDER BY updated ASC';

const APP_HTML = "<!doctype html><html><head></head><body>Atlassian</body></html>";

export type WitnessCall = { name: string; args: Record<string, unknown> };

/** What one dashboard tile shows the member after a launch attempt. */
export interface DashboardTileFacts {
  text: string;
  badgeFailed: boolean;
  /** The pre-fix generic 500 text. */
  opaque: boolean;
  namesCloudId: boolean;
}

export interface DashboardTilesFacts {
  confluence: DashboardTileFacts | null;
  jql: DashboardTileFacts | null;
}

function parseTileFacts(value: unknown): DashboardTileFacts | null {
  if (!isRecord(value) || typeof value.text !== "string") return null;
  return {
    text: value.text,
    badgeFailed: value.badgeFailed === true,
    opaque: value.opaque === true,
    namesCloudId: value.namesCloudId === true,
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} was not an object: ${JSON.stringify(value)}`);
  return value;
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
  response.writeHead(status, { "cache-control": "no-store", "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The Atlassian witness did not bind a TCP port.");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

function withDispose<T extends object>(value: T, dispose: () => Promise<void>): T & AsyncDisposable {
  return Object.assign(value, { [Symbol.asyncDispose]: dispose });
}

export function atlassianWitnessRpc(
  message: Record<string, unknown>,
  receivedCalls: WitnessCall[],
): Record<string, unknown> | null {
  if (message.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: {
          tools: { listChanged: false },
          resources: { listChanged: false, subscribe: false },
          extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } },
        },
        serverInfo: { name: "atlassian-remote-mcp-witness", version: "1.0.0" },
      },
    };
  }
  if (message.id === undefined) return null;
  if (message.method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [
          {
            name: "getConfluencePage",
            title: "Get Confluence page",
            description: "Get a Confluence page by id.",
            inputSchema: {
              type: "object",
              properties: { cloudId: { type: "string" }, pageId: { type: "string" } },
              required: ["cloudId", "pageId"],
            },
            annotations: { readOnlyHint: true, destructiveHint: false },
            _meta: { ui: { resourceUri: confluenceResourceUri, visibility: ["model", "app"] } },
          },
          {
            name: "searchJiraIssuesUsingJql",
            title: "Search Jira issues using JQL",
            description: "Search Jira issues with a JQL query.",
            inputSchema: {
              type: "object",
              properties: { cloudId: { type: "string" }, jql: { type: "string" } },
              required: ["cloudId", "jql"],
            },
            annotations: { readOnlyHint: true, destructiveHint: false },
            _meta: { ui: { resourceUri: jiraResourceUri, visibility: ["model", "app"] } },
          },
        ],
      },
    };
  }
  if (message.method === "resources/read") {
    const params = isRecord(message.params) ? message.params : {};
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        contents: [{
          uri: params.uri,
          mimeType: "text/html;profile=mcp-app",
          text: APP_HTML,
          _meta: {
            ui: {
              csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] },
              prefersBorder: true,
            },
          },
        }],
      },
    };
  }
  if (message.method === "tools/call") {
    const params = isRecord(message.params) ? message.params : {};
    const name = typeof params.name === "string" ? params.name : "";
    const args = isRecord(params.arguments) ? params.arguments : {};
    receivedCalls.push({ name, args });
    if (typeof args.cloudId !== "string" || !args.cloudId) {
      return {
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32602,
          message: `Invalid arguments for tool ${name}: [{"code":"invalid_type","expected":"string","received":"undefined","path":["cloudId"],"message":"Required"}]`,
        },
      };
    }
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: { content: [{ type: "text", text: `ok:${name}` }], structuredContent: { ok: true } },
    };
  }
  return { jsonrpc: "2.0", id: message.id, result: {} };
}

/** A loopback MCP server shaped like the Atlassian remote MCP. */
export function createAtlassianWitness(receivedCalls: WitnessCall[]): Server {
  return createServer((request, response) => {
    void (async () => {
      if (request.method !== "POST") {
        sendJson(response, 405, { error: "method_not_allowed" });
        return;
      }
      const raw = await readBody(request);
      const parsed: unknown = raw.trim() ? JSON.parse(raw) : {};
      const messages = Array.isArray(parsed) ? parsed : [parsed];
      const replies = messages.flatMap((entry) => {
        if (!isRecord(entry)) return [];
        const reply = atlassianWitnessRpc(entry, receivedCalls);
        return reply ? [reply] : [];
      });
      if (replies.length === 0) {
        response.writeHead(202);
        response.end();
        return;
      }
      sendJson(response, 200, Array.isArray(parsed) ? replies : replies[0]);
    })().catch((error: unknown) => {
      if (!response.headersSent) sendJson(response, 500, { error: String(error) });
      else response.destroy(error instanceof Error ? error : undefined);
    });
  });
}

async function activeOrganizationId(seed: Seed, session: DenSession): Promise<string> {
  const result = await seed.api(session, "/v1/me/orgs");
  const orgs = isRecord(result.body) && Array.isArray(result.body.orgs) ? result.body.orgs.filter(isRecord) : [];
  const id = orgs[0] && typeof orgs[0].id === "string" ? orgs[0].id : "";
  if (!result.response.ok || !id) {
    throw new Error(`Resolving the active organization failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return id;
}

async function mintMcpTokens(seed: Seed, den: Den, organizationId: string): Promise<{ mcpToken: string; appHostToken: string }> {
  const result = await seed.api(den.admin, "/v1/mcp/token", {
    method: "POST",
    headers: { "x-openwork-org-id": organizationId },
    body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }),
  });
  const body = requireRecord(result.body, "MCP token response");
  const mcpToken = typeof body.token === "string" ? body.token : "";
  const appHostToken = typeof body.appHostToken === "string" ? body.appHostToken : "";
  if (!result.response.ok || !mcpToken || !appHostToken) {
    throw new Error(`Minting the MCP tokens failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return { mcpToken, appHostToken };
}

export async function atlassianDashboardTiles(seed: Seed) {
  const receivedCalls: WitnessCall[] = [];
  const witness = createAtlassianWitness(receivedCalls);
  const witnessUrl = `${await listen(witness)}/mcp`;
  try {
    const den = await seed.den({
      env: { DEN_DASHBOARDS_ENABLED: "true" },
      org: { name: `Dashboard launch input ${Date.now()}`, admin: { name: "Avery" } },
    });
    const organizationId = await activeOrganizationId(seed, den.admin);
    const orgHeaders = { "x-openwork-org-id": organizationId };
    const connection = await seed.orgConnection(den.admin, {
      name: "Atlassian (One org account)",
      url: witnessUrl,
      authType: "none",
      credentialMode: "shared",
      access: { orgWide: true },
    });

    const appsResult = await seed.api(den.admin, `/v1/mcp-connections/${connection.id}/mcp-apps`, { headers: orgHeaders });
    if (appsResult.response.status !== 200) {
      throw new Error(`Listing connection MCP Apps failed: HTTP ${appsResult.response.status} ${appsResult.text.slice(0, 500)}`);
    }
    const apps = isRecord(appsResult.body) && Array.isArray(appsResult.body.apps) ? appsResult.body.apps.filter(isRecord) : [];
    const confluenceApp = requireRecord(apps.find((entry) => entry.toolName === "getConfluencePage"), "Confluence app entry");
    const jqlApp = requireRecord(apps.find((entry) => entry.toolName === "searchJiraIssuesUsingJql"), "JQL app entry");

    // Mirror the add-app dialog: bare JSON.parse of the pasted text.
    const confluenceArguments = requireRecord(JSON.parse(pastedConfluenceJson), "Confluence launch input");
    const jqlArguments = requireRecord(JSON.parse(pastedJqlJson), "JQL launch input");
    const createResult = await seed.api(den.admin, "/v1/dashboards", {
      method: "POST",
      headers: orgHeaders,
      body: JSON.stringify({
        name: "Atlassian board",
        elements: [
          {
            serverName: String(confluenceApp.serverName ?? ""),
            connectionId: connection.id,
            toolName: "getConfluencePage",
            projectedToolName: String(confluenceApp.projectedToolName ?? ""),
            resourceUri: confluenceResourceUri,
            title: confluenceTileTitle,
            launchArguments: confluenceArguments,
          },
          {
            serverName: String(jqlApp.serverName ?? ""),
            connectionId: connection.id,
            toolName: "searchJiraIssuesUsingJql",
            projectedToolName: String(jqlApp.projectedToolName ?? ""),
            resourceUri: jiraResourceUri,
            title: jiraTileTitle,
            launchArguments: jqlArguments,
          },
        ],
      }),
    });
    if (createResult.response.status !== 201) {
      throw new Error(`Creating the dashboard failed: HTTP ${createResult.response.status} ${createResult.text.slice(0, 500)}`);
    }
    const dashboardId = String(requireRecord(requireRecord(createResult.body, "dashboard response").item, "dashboard item").id ?? "");
    const grantResult = await seed.api(den.admin, `/v1/dashboards/${dashboardId}/access`, {
      method: "POST",
      headers: orgHeaders,
      body: JSON.stringify({ orgWide: true, role: "viewer" }),
    });
    if (grantResult.response.status !== 201) {
      throw new Error(`Granting the dashboard failed: HTTP ${grantResult.response.status} ${grantResult.text.slice(0, 500)}`);
    }

    const { mcpToken, appHostToken } = await mintMcpTokens(seed, den, organizationId);
    const app = await seed.desktop({ den, as: "admin" });
    const workspace = await seed.workspace(app, seed.tmpPath("dashboard-launch-input"));
    // The signed-in harness Desktop does not run the production Cloud
    // provisioning loop, so hand it the same Connect MCP configuration the
    // product writes: the central Cloud MCP entry plus the private App-host
    // authorization. This is the documented reconcile surface, not a stub.
    // TODO(primitive): seed.connectMcp
    const reconciled = await rawEvalIn(app, `(async () => {
      const port = localStorage.getItem("openwork.server.port");
      const token = localStorage.getItem("openwork.server.token");
      if (!port || !token) return "missing local server credentials";
      const response = await fetch("http://127.0.0.1:" + port + "/workspace/" + encodeURIComponent(${JSON.stringify(workspace.workspaceId)}) + "/mcp/openwork-cloud/reconcile", {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({
          config: {
            type: "remote",
            url: ${JSON.stringify(`${den.ref.apiUrl}/mcp/agent`)},
            enabled: true,
            headers: { Authorization: ${JSON.stringify(`Bearer ${mcpToken}`)} },
            oauth: false,
          },
          appHostAuthorization: ${JSON.stringify(`Bearer ${appHostToken}`)},
          trigger: "dashboard-launch-input-world",
        }),
      });
      const text = await response.text();
      return response.ok ? "ok" : "HTTP " + response.status + " " + text.slice(0, 1_000);
    })()`, { awaitPromise: true, timeoutMs: 120_000 });
    if (reconciled !== "ok") throw new Error(`Reconciling Connect MCP for the desktop failed: ${String(reconciled)}`);

    const section = `[data-granted-dashboard="${dashboardId}"]`;
    return withDispose({
      app,
      dashboardId,
      connectionId: connection.id,
      receivedCalls,
      /**
       * Opens the Dashboard from the sidebar navigation, which renders only
       * after Desktop reads dashboardEnabled from /v1/me/desktop-config.
       * Returns whether the navigation was clicked yet; opens a collapsed
       * sidebar on the way.
       */
      // TODO(primitive): user.click({ role: "button", text: "Dashboard" }) should locate the sidebar rail entry and open a collapsed sidebar.
      async openDashboard(): Promise<boolean> {
        const opened = await rawEvalIn(app, `(() => {
          const button = [...document.querySelectorAll("button")]
            .find((entry) => entry.textContent?.trim() === "Dashboard");
          if (button instanceof HTMLButtonElement && !button.disabled) {
            button.click();
            // In a narrow harness window the sidebar is an overlay that covers
            // the tile grid; collapse it so tiles are hit-testable.
            const toggle = [...document.querySelectorAll("button")]
              .find((entry) => (entry.getAttribute("aria-label") ?? entry.textContent ?? "").trim() === "Toggle Sidebar");
            if (toggle instanceof HTMLButtonElement) toggle.click();
            return true;
          }
          const sidebarOpen = [...document.querySelectorAll("button")]
            .some((entry) => entry.textContent?.includes("Search sessions"));
          if (!sidebarOpen) {
            const toggle = [...document.querySelectorAll("button")]
              .find((entry) => (entry.getAttribute("aria-label") ?? entry.textContent ?? "").trim() === "Toggle Sidebar");
            if (toggle instanceof HTMLButtonElement) toggle.click();
          }
          return false;
        })()`);
        return opened === true;
      },
      /** True once both granted tiles render with their Run buttons. */
      // TODO(primitive): probe.dashboardTiles should expose granted tiles and their launch controls.
      async tilesReady(): Promise<boolean> {
        const ready = await rawEvalIn(app, `(() => {
          const section = document.querySelector(${JSON.stringify(section)});
          return section instanceof HTMLElement
            && section.innerText.includes(${JSON.stringify(confluenceTileTitle)})
            && section.innerText.includes(${JSON.stringify(jiraTileTitle)})
            && Boolean(section.querySelector('button[aria-label="Run ${confluenceTileTitle}"]'))
            && Boolean(section.querySelector('button[aria-label="Run ${jiraTileTitle}"]'));
        })()`);
        return ready === true;
      },
      /** The member-visible state of both tiles. */
      // TODO(primitive): probe.dashboardTiles
      async tiles(): Promise<DashboardTilesFacts> {
        const value = await rawEvalIn(app, `(() => {
          const section = document.querySelector(${JSON.stringify(section)});
          if (!(section instanceof HTMLElement)) return null;
          const tiles = [...section.querySelectorAll("[data-dashboard-entry]")];
          const read = (title) => {
            const tile = tiles.find((entry) => entry.textContent?.includes(title));
            if (!(tile instanceof HTMLElement)) return null;
            return {
              text: tile.innerText.replace(/\\s+/g, " ").trim(),
              badgeFailed: tile.innerText.includes("Refresh failed"),
              opaque: tile.innerText.includes("Unexpected server error"),
              namesCloudId: tile.innerText.includes("cloudId"),
            };
          };
          return { confluence: read(${JSON.stringify(confluenceTileTitle)}), jql: read(${JSON.stringify(jiraTileTitle)}) };
        })()`);
        const facts = isRecord(value) ? value : {};
        return { confluence: parseTileFacts(facts.confluence), jql: parseTileFacts(facts.jql) };
      },
    }, () => closeServer(witness));
  } catch (error) {
    await closeServer(witness);
    throw error;
  }
}
