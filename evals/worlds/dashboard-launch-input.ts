import type { Den, Seed } from "@openwork/env";
import { evalIn as rawEvalIn } from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";

import {
  atlassianAppTools, confluenceResourceUri, jiraResourceUri,
  confluenceTileTitle, jiraTileTitle, pastedConfluenceJson, pastedJqlJson,
} from "@openwork/labs";
export { confluenceTileTitle, jiraTileTitle, expectedJql } from "@openwork/labs";

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
  const den = await seed.den({
    env: { DEN_DASHBOARDS_ENABLED: "true" },
    mocks: { atlassian: seed.mock({ allowUnauthenticatedMcp: true, tools: atlassianAppTools }) },
    org: { name: `Dashboard launch input ${Date.now()}`, admin: { name: "Avery" } },
  });
  const organizationId = await activeOrganizationId(seed, den.admin);
  const orgHeaders = { "x-openwork-org-id": organizationId };
  const connection = await seed.orgConnection(den.admin, {
    name: "Atlassian (One org account)",
    url: den.mocks.atlassian.mcpUrl,
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
  // The private test Den must be the installation's activated origin before
  // the real App host will accept its credentials. Local dev loopback alone
  // hid this prerequisite; seeding it leaves the product trust checks intact.
  const app = await seed.desktop({ den, as: "admin", enterpriseActivated: true });
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
  return {
    app,
    dashboardId,
    connectionId: connection.id,
    witness: den.mocks.atlassian,
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
  };
}
