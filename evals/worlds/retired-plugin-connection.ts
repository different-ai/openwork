import { mkdir, realpath } from "node:fs/promises";
import { denFetch, signInDesktopAs, type DenSession } from "@openwork/behaviors";
import type { MockMcpTool } from "@openwork/labs";
import type { Seed } from "@openwork/env";
import { isRecord } from "./openwork-server-cli.ts";

const INDEX_URI = "openwork://connect/mcp-servers/index.json";

function tool(name: string, text: string): MockMcpTool {
  return {
    name,
    description: `Deterministic ${name} fixture`,
    inputSchema: { type: "object", properties: { note: { type: "string" } } },
    result: { content: [{ type: "text", text }] },
  };
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringField(value: unknown, key: string, label: string): string {
  const field = isRecord(value) ? value[key] : undefined;
  if (typeof field !== "string" || !field) throw new Error(`Missing ${key} in ${label}`);
  return field;
}

export interface IndexEntry { connectionId: string; name: string; exposeDirectly: boolean }

/**
 * An organization with one member and two no-sign-in MCP servers:
 * - "CRM": created by a plugin (the plugin owns the connection), then also
 *   shared with everyone directly and exposed to desktops as its own server;
 * - "Notes": an ordinary connection an admin added, shared with everyone.
 * The spec archives and restores the plugin; everything else is arranged here.
 */
export async function retiredPluginConnection(seed: Seed) {
  return arrangeRetiredPluginConnection(seed, { web: false });
}

/**
 * The same organization, with the admin (who owns the plugin) signed in to the
 * real app in a browser. Den API calls go through the app's same-origin proxy,
 * as a hosted web build does.
 */
export async function retiredPluginConnectionInApp(seed: Seed) {
  const world = await arrangeRetiredPluginConnection(seed, { web: false });
  const { den } = world;
  const folder = seed.tmpPath("retired-plugin-connection");
  await mkdir(folder, { recursive: true });
  const workspacePath = await realpath(folder);
  const app = await seed.appWeb({
    name: "retired-plugin-connection", workspacePath, headless: true,
    env: {
      OPENWORK_DEV_HEADLESS_WEB_DEN_PROXY: "1", OPENWORK_DEV_DEN_PROXY_TARGET: den.ref.webUrl,
      OPENWORK_DEV_HEADLESS_DEN_API_TARGET: den.ref.apiUrl,
      VITE_DEN_BASE_URL: den.ref.webUrl, VITE_DEN_API_BASE_URL: "/api/den",
    },
  });
  await signInDesktopAs(app, { ...den.ref, apiUrl: `${app.webUrl}/api/den` }, den.admin);
  return { ...world, app };
}

async function arrangeRetiredPluginConnection(seed: Seed, options: { web: false }) {
  const runId = `${Date.now().toString(36)}${process.pid.toString(36)}`;
  const orgName = `Retired plugin connection ${runId}`;
  const pluginName = "CRM tools";
  const crmTool = "crm_lookup";
  const notesTool = "notes_lookup";
  const den = await seed.den({
    web: options.web,
    org: { name: orgName, members: { member: {} } },
    mocks: {
      crm: seed.mock({ allowUnauthenticatedMcp: true, tools: [tool(crmTool, "crm result")] }),
      notes: seed.mock({ allowUnauthenticatedMcp: true, tools: [tool(notesTool, "notes result")] }),
    },
  });
  const member = den.members.member;
  if (!member) throw new Error("The member was not provisioned");
  const crmMock = den.mocks.crm;
  const notesMock = den.mocks.notes;
  if (!crmMock || !notesMock) throw new Error("The MCP mocks were not started");

  const orgs = await denFetch(den.admin, "/v1/me/orgs", { headers: { authorization: `Bearer ${den.admin.token}` } });
  const orgId = records(isRecord(orgs.body) ? orgs.body.orgs : null).find((org) => org.name === orgName)?.id;
  if (typeof orgId !== "string") throw new Error(`Test organization not found: HTTP ${orgs.response.status}`);

  const call = async (session: DenSession, path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${session.token}`);
    headers.set("x-openwork-org-id", orgId);
    return denFetch(session, path, { ...init, headers });
  };
  const expectStatus = (result: { response: Response; text: string }, status: number, label: string) => {
    if (result.response.status !== status) throw new Error(`${label}: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  };

  // The plugin creates and owns the CRM connection.
  const plugin = await call(den.admin, "/v1/plugins", {
    method: "POST",
    body: JSON.stringify({
      name: pluginName,
      orgWide: true,
      components: [{
        type: "mcp",
        input: { normalizedPayloadJson: { mcpServers: { crm: { type: "remote", url: crmMock.mcpUrl } } }, metadata: { name: "CRM" } },
        connection: { authType: "none", credentialMode: "shared" },
      }],
    }),
  });
  expectStatus(plugin, 201, "Creating the plugin");
  const pluginId = stringField(isRecord(plugin.body) ? plugin.body.item : null, "id", "created plugin");

  const manageable = await call(den.admin, "/v1/mcp-connections?scope=manageable");
  expectStatus(manageable, 200, "Listing connections");
  const crmRow = records(isRecord(manageable.body) ? manageable.body.connections : null).find((row) => row.url === crmMock.mcpUrl);
  if (!crmRow) throw new Error(`The plugin did not create its connection: ${manageable.text.slice(0, 500)}`);
  const crmId = stringField(crmRow, "id", "plugin connection");
  const crmName = stringField(crmRow, "name", "plugin connection");

  // The admin also shares it with everyone directly and exposes it to desktops.
  const everyone = { orgWide: true, memberIds: [], teamIds: [] };
  const shared = await call(den.admin, `/v1/mcp-connections/${encodeURIComponent(crmId)}/access`, {
    method: "PUT", body: JSON.stringify({ access: everyone }),
  });
  expectStatus(shared, 200, "Sharing the plugin connection with everyone");
  const exposed = await call(den.admin, `/v1/mcp-connections/${encodeURIComponent(crmId)}`, {
    method: "PUT",
    body: JSON.stringify({
      expectedUpdatedAt: stringField(shared.body, "updatedAt", "shared connection"),
      name: crmName, url: crmMock.mcpUrl, authType: "none", credentialMode: "shared",
      exposeDirectly: true, access: everyone,
    }),
  });
  expectStatus(exposed, 200, "Exposing the plugin connection directly");

  // An ordinary admin-added connection: the boundary that must not change.
  const notesName = "Notes";
  const notes = await call(den.admin, `/v1/mcp-connections/by-key/notes-${runId}`, {
    method: "PUT",
    body: JSON.stringify({ name: notesName, url: notesMock.mcpUrl, authType: "none", credentialMode: "shared", exposeDirectly: true, access: { orgWide: true } }),
  });
  expectStatus(notes, 201, "Adding the Notes connection");
  const notesId = stringField(notes.body, "id", "Notes connection");

  const minted = await call(member, "/v1/mcp/token", { method: "POST", body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }) });
  expectStatus(minted, 200, "Minting the member's MCP tokens");
  const memberToken = stringField(minted.body, "token", "member tokens");
  const memberAppHostToken = stringField(minted.body, "appHostToken", "member tokens");

  let rpcId = 0;
  const rpc = async (bearer: string, method: string, params: Record<string, unknown>, appHost: boolean) => {
    const headers: Record<string, string> = {
      authorization: `Bearer ${bearer}`, "content-type": "application/json", accept: "application/json, text/event-stream",
    };
    if (appHost) headers["x-openwork-mcp-client-capabilities"] = "mcp-app-host-v1";
    const response = await fetch(`${den.ref.apiUrl}/mcp/agent`, {
      method: "POST", headers, signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    });
    const raw = await response.text();
    if (response.status !== 200) throw new Error(`MCP ${method}: HTTP ${response.status} ${raw.slice(0, 500)}`);
    const data = raw.split("\n").find((line) => line.startsWith("data:"));
    const frame: unknown = JSON.parse(data ? data.slice(5) : raw);
    if (!isRecord(frame) || !isRecord(frame.result)) throw new Error(`MCP ${method} returned no result: ${raw.slice(0, 500)}`);
    return frame.result;
  };

  const readIndex = async (appHost: boolean): Promise<IndexEntry[]> => {
    const result = await rpc(appHost ? memberAppHostToken : memberToken, "resources/read", { uri: INDEX_URI }, appHost);
    const text = records(result.contents)[0]?.text;
    if (typeof text !== "string") throw new Error("The connection index had no content");
    const index: unknown = JSON.parse(text);
    return records(isRecord(index) ? index.servers : null).map((entry) => ({
      connectionId: String(entry.connectionId), name: String(entry.name), exposeDirectly: entry.exposeDirectly === true,
    }));
  };

  const setPluginArchived = async (archived: boolean) => {
    const result = await call(den.admin, `/v1/plugins/${encodeURIComponent(pluginId)}/${archived ? "archive" : "restore"}`, { method: "POST" });
    return result.response.status;
  };

  return {
    den, pluginName,
    crm: { id: crmId, name: crmName, tool: crmTool, mock: crmMock },
    notes: { id: notesId, name: notesName, tool: notesTool, mock: notesMock },
    /** What Library › Delete calls. */
    archivePlugin: () => setPluginArchived(true),
    restorePlugin: () => setPluginArchived(false),
    /** The member's view: the index an ordinary MCP client and the desktop app host read, and the usable Connections list. */
    async memberView() {
      const usable = await call(member, "/v1/mcp-connections?scope=usable");
      expectStatus(usable, 200, "Listing the member's usable connections");
      return {
        ordinary: await readIndex(false),
        appHost: await readIndex(true),
        usable: records(isRecord(usable.body) ? usable.body.connections : null).map((row) => String(row.id)),
      };
    },
    /** The member's agent runs one tool through execute_capability. */
    async memberRuns(connectionId: string, toolName: string, note: string) {
      const result = await rpc(memberToken, "tools/call", {
        name: "execute_capability",
        arguments: { name: `mcp:${connectionId}:${toolName}`, body: { note } },
      }, false);
      const text = records(result.content).map((part) => typeof part.text === "string" ? part.text : "").join("");
      let error = "";
      try {
        const parsed: unknown = JSON.parse(text);
        if (isRecord(parsed) && typeof parsed.error === "string") error = parsed.error;
      } catch { /* provider text */ }
      return { isError: result.isError === true, error, text };
    },
  };
}
