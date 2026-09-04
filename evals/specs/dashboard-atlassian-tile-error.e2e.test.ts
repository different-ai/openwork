/**
 * Customer report (2026-09): Dashboard tiles for the Atlassian remote MCP
 * "don't work" with the exact pasted JSON payloads, identically across an
 * org-account and an individual-accounts connection.
 *
 * Root cause: both payloads omit the required `cloudId` argument. Before the
 * fix every hop hid the provider's rejection and the tile read "Unexpected
 * server error".
 *
 * This spec drives the real Desktop dashboard tile against a deterministic
 * Atlassian-shaped witness MCP through a real Den connection proxy — no
 * fetch stubs — and asserts the member now sees the provider's own rejection
 * naming `cloudId` on the tile, never the generic 500 text. The witness proves
 * the pasted launch arguments arrived byte-identically.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { expect, onTestFinished } from "vitest";
import { createOrgConnection, denFetch, evalIn, waitFor } from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import { app, needs, server, test, unmetNeeds } from "@openwork/testkit";
import type { TestNeeds } from "@openwork/testkit";

const requirements: TestNeeds = {
  optIn: ["OPENWORK_EVAL_E2E_TESTS"],
};
const missingRequirements = unmetNeeds(requirements, process.env);
// The Atlassian witness is an inline loopback MCP server, so Den must run in
// the same place — the same local-placement constraint remote-mcp-apps uses.
const localPlacement = process.env.OPENWORK_EVAL_DAYTONA !== "1"
  && !process.env.OPENWORK_EVAL_DEN_API_URL?.trim();
const title = missingRequirements.length > 0
  ? `dashboard Atlassian tile error skipped — needs: ${missingRequirements.join(", ")}`
  : !localPlacement
    ? "dashboard Atlassian tile error skipped — needs local placement without OPENWORK_EVAL_DAYTONA/OPENWORK_EVAL_DEN_API_URL"
    : "a dashboard tile launched with the reported Atlassian JSON names the missing required argument";

const CONFLUENCE_RESOURCE = "ui://atlassian/confluence-page/view.html";
const JIRA_RESOURCE = "ui://atlassian/jql-search/view.html";
const APP_HTML = "<!doctype html><html><head></head><body>Atlassian</body></html>";
const PASTED_CONFLUENCE_JSON = `{"pageId": "1122334455"}`;
const PASTED_JQL_JSON = `{ "jql": "project = HELPDESK AND status NOT IN (\\"Closed\\", \\"Resolved\\", \\"Duplicate\\", \\"Declined\\", \\"Spam\\") AND assignee = currentUser() ORDER BY updated ASC" }`;
const EXPECTED_JQL = 'project = HELPDESK AND status NOT IN ("Closed", "Resolved", "Duplicate", "Declined", "Spam") AND assignee = currentUser() ORDER BY updated ASC';

function isRecord(value: unknown): value is Record<string, unknown> {
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

type WitnessCall = { name: string; args: Record<string, unknown> };

function atlassianWitnessRpc(
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
            _meta: { ui: { resourceUri: CONFLUENCE_RESOURCE, visibility: ["model", "app"] } },
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
            _meta: { ui: { resourceUri: JIRA_RESOURCE, visibility: ["model", "app"] } },
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

test.skipIf(!localPlacement)(title, { timeout: 480_000 }, async ({ evidence, place }) => {
  needs(requirements);

  const receivedCalls: WitnessCall[] = [];
  const witness = createServer((request, response) => {
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
    org: { name: `Dashboard Atlassian tile ${Date.now()}`, admin: { name: "Avery" } },
  });
  const orgId = await organizationId(den.admin);
  const headers = orgHeaders(den.admin, orgId);

  const connection = await createOrgConnection(den.admin, {
    name: "Atlassian (One org account)",
    url: witnessUrl,
    authType: "none",
    credentialMode: "shared",
    access: { orgWide: true },
  });

  const appsResult = await denFetch(den.admin, `/v1/mcp-connections/${connection.id}/mcp-apps`, { headers });
  expect(appsResult.response.status, appsResult.text).toBe(200);
  const apps = isRecord(appsResult.body) && Array.isArray(appsResult.body.apps)
    ? appsResult.body.apps.filter(isRecord)
    : [];
  const confluenceApp = requireRecord(apps.find((entry) => entry.toolName === "getConfluencePage"), "Confluence app entry");
  const jqlApp = requireRecord(apps.find((entry) => entry.toolName === "searchJiraIssuesUsingJql"), "JQL app entry");

  const confluenceArguments = requireRecord(JSON.parse(PASTED_CONFLUENCE_JSON), "Confluence launch input");
  const jqlArguments = requireRecord(JSON.parse(PASTED_JQL_JSON), "JQL launch input");
  expect(jqlArguments.jql).toBe(EXPECTED_JQL);
  const createResult = await denFetch(den.admin, "/v1/dashboards", {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "Atlassian board",
      elements: [
        {
          serverName: String(confluenceApp.serverName ?? ""),
          connectionId: connection.id,
          toolName: "getConfluencePage",
          projectedToolName: String(confluenceApp.projectedToolName ?? ""),
          resourceUri: CONFLUENCE_RESOURCE,
          title: "Confluence page",
          launchArguments: confluenceArguments,
        },
        {
          serverName: String(jqlApp.serverName ?? ""),
          connectionId: connection.id,
          toolName: "searchJiraIssuesUsingJql",
          projectedToolName: String(jqlApp.projectedToolName ?? ""),
          resourceUri: JIRA_RESOURCE,
          title: "Jira queue",
          launchArguments: jqlArguments,
        },
      ],
    }),
  });
  expect(createResult.response.status, createResult.text).toBe(201);
  const dashboard = requireRecord(requireRecord(createResult.body, "dashboard response").item, "dashboard item");
  const dashboardId = String(dashboard.id ?? "");
  const grantResult = await denFetch(den.admin, `/v1/dashboards/${dashboardId}/access`, {
    method: "POST",
    headers,
    body: JSON.stringify({ orgWide: true, role: "viewer" }),
  });
  expect(grantResult.response.status, grantResult.text).toBe(201);

  const tokenResult = await denFetch(den.admin, "/v1/mcp/token", {
    method: "POST",
    headers: { authorization: `Bearer ${den.admin.token}`, "x-openwork-org-id": orgId },
    body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }),
  });
  expect(tokenResult.response.ok, tokenResult.text).toBe(true);
  const tokenBody = requireRecord(tokenResult.body, "MCP token response");
  const mcpToken = String(tokenBody.token ?? "");
  const appHostMcpToken = String(tokenBody.appHostToken ?? "");
  expect(mcpToken).not.toBe("");
  expect(appHostMcpToken).not.toBe("");

  await using desktop = await app({ den, as: "admin", place });

  // The signed-in harness Desktop does not run the production Cloud
  // provisioning loop, so hand it the same Connect MCP configuration the
  // product writes: the central Cloud MCP entry plus the private App-host
  // authorization. This is the documented reconcile surface, not a stub.
  const reconciled = await evalIn(desktop, `(async () => {
    const port = localStorage.getItem("openwork.server.port");
    const token = localStorage.getItem("openwork.server.token");
    if (!port || !token) return "missing local server credentials";
    const response = await fetch("http://127.0.0.1:" + port + "/workspace/" + encodeURIComponent(${JSON.stringify(desktop.workspaceId)}) + "/mcp/openwork-cloud/reconcile", {
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
        appHostAuthorization: ${JSON.stringify(`Bearer ${appHostMcpToken}`)},
        trigger: "dashboard-atlassian-tile-error",
      }),
    });
    const text = await response.text();
    return response.ok ? "ok" : "HTTP " + response.status + " " + text.slice(0, 1_000);
  })()`, { awaitPromise: true, timeoutMs: 120_000 });
  expect(reconciled).toBe("ok");

  // The Dashboard navigation lives in the sidebar and renders only after
  // Desktop reads dashboardEnabled from /v1/me/desktop-config. Open the
  // sidebar if it is collapsed, then wait for the button.
  const findDashboardButton = `[...document.querySelectorAll("button")]
      .find((entry) => entry.textContent?.trim() === "Dashboard")`;
  await waitFor(desktop, `(() => {
    const button = ${findDashboardButton};
    if (button instanceof HTMLButtonElement && !button.disabled) return true;
    const sidebarOpen = [...document.querySelectorAll("button")]
      .some((entry) => entry.textContent?.includes("Search sessions"));
    if (!sidebarOpen) {
      const toggle = [...document.querySelectorAll("button")]
        .find((entry) => (entry.getAttribute("aria-label") ?? entry.textContent ?? "").trim() === "Toggle Sidebar");
      if (toggle instanceof HTMLButtonElement) toggle.click();
    }
    return false;
  })()`, {
    timeoutMs: 90_000,
    label: "Dashboard navigation available",
  });
  const dashboardOpened = await evalIn(desktop, `(() => {
    const button = [...document.querySelectorAll("button")]
      .find((entry) => entry.textContent?.trim() === "Dashboard");
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  })()`);
  expect(dashboardOpened).toBe(true);
  await waitFor(desktop, `(() => {
    const section = document.querySelector(${JSON.stringify(`[data-granted-dashboard="${dashboardId}"]`)});
    return section instanceof HTMLElement
      && section.innerText.includes("Confluence page")
      && section.innerText.includes("Jira queue")
      && Boolean(section.querySelector('button[aria-label="Run Confluence page"]'))
      && Boolean(section.querySelector('button[aria-label="Run Jira queue"]'));
  })()`, {
    timeoutMs: 90_000,
    label: "granted Atlassian dashboard tiles rendered with Run buttons",
  });

  // Launch both tiles exactly as the member does: press Run.
  receivedCalls.length = 0;
  for (const tile of ["Confluence page", "Jira queue"]) {
    const ran = await evalIn(desktop, `(() => {
      const button = document.querySelector(${JSON.stringify(`button[aria-label="Run ${tile}"]`)});
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click();
      return true;
    })()`);
    expect(ran, `Run button for ${tile}`).toBe(true);
  }

  await waitFor(desktop, `(() => {
    const section = document.querySelector(${JSON.stringify(`[data-granted-dashboard="${dashboardId}"]`)});
    if (!(section instanceof HTMLElement)) return false;
    const tiles = [...section.querySelectorAll("[data-dashboard-entry]")];
    const confluence = tiles.find((tile) => tile.textContent?.includes("Confluence page"));
    const jql = tiles.find((tile) => tile.textContent?.includes("Jira queue"));
    return confluence instanceof HTMLElement
      && jql instanceof HTMLElement
      && confluence.innerText.includes("cloudId")
      && jql.innerText.includes("cloudId");
  })()`, {
    timeoutMs: 120_000,
    label: "both Atlassian tiles name the missing required argument",
  });

  const tileState = await evalIn(desktop, `(() => {
    const section = document.querySelector(${JSON.stringify(`[data-granted-dashboard="${dashboardId}"]`)});
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
    return { confluence: read("Confluence page"), jql: read("Jira queue") };
  })()`);
  const state = requireRecord(tileState, "tile state");
  const confluenceTile = requireRecord(state.confluence, "Confluence tile state");
  const jqlTile = requireRecord(state.jql, "JQL tile state");
  // The launch still fails (cloudId is genuinely missing), but the member now
  // reads the provider's rejection naming the argument, not a generic 500.
  expect(confluenceTile.badgeFailed).toBe(true);
  expect(jqlTile.badgeFailed).toBe(true);
  expect(confluenceTile.namesCloudId).toBe(true);
  expect(jqlTile.namesCloudId).toBe(true);
  expect(confluenceTile.opaque).toBe(false);
  expect(jqlTile.opaque).toBe(false);
  expect(String(confluenceTile.text)).toContain("rejected the tool arguments");
  expect(String(jqlTile.text)).toContain("rejected the tool arguments");

  // The witness saw both launches with the pasted arguments byte-identical
  // and no cloudId — the provider rejection is the only failure in the chain.
  const witnessedByTool = new Map(receivedCalls.map((call) => [call.name, call.args]));
  expect(witnessedByTool.get("getConfluencePage")).toEqual({ pageId: "1122334455" });
  expect(witnessedByTool.get("searchJiraIssuesUsingJql")).toEqual({ jql: EXPECTED_JQL });

  evidence.recordAssertionEvidence(
    "The dashboard tile names the missing required argument instead of a generic server error",
    `After Run, both tiles show the "Refresh failed" badge with the provider's rejection naming cloudId and never "Unexpected server error" (confluence=${JSON.stringify(confluenceTile)}, jql=${JSON.stringify(jqlTile)}).`,
    confluenceTile.namesCloudId === true && jqlTile.namesCloudId === true
      && confluenceTile.opaque === false && jqlTile.opaque === false,
  );
  evidence.recordAssertionEvidence(
    "The pasted launch JSON reached the provider intact",
    `The witness received getConfluencePage ${JSON.stringify(witnessedByTool.get("getConfluencePage"))} and searchJiraIssuesUsingJql with the exact single-escaped JQL string; the provider rejected both for the missing required cloudId with JSON-RPC -32602.`,
    JSON.stringify(witnessedByTool.get("searchJiraIssuesUsingJql")) === JSON.stringify({ jql: EXPECTED_JQL }),
  );
});
