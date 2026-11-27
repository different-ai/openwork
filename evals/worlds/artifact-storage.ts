import { allocateFreePorts } from "@openwork/cdp";
import { readCurrentOrganizationMemberId } from "@openwork/behaviors";
import type { Seed } from "@openwork/env";
import { isRecord, records, stringField } from "./library.ts";
import { seededOrganizationId } from "./organization-capabilities.ts";
import { denForAppWeb, signedInAppWeb } from "./signed-in-app-web.ts";

const STORAGE = {
  collections: [{
    name: "requests",
    description: "Equipment the team has asked for.",
    fields: [
      { name: "item", type: "text", required: true },
      { name: "reason", type: "text" },
      { name: "status", type: "text", options: ["new", "approved", "declined"] },
    ],
  }],
};

/**
 * One organization where Sam built an equipment-request artifact that saves
 * its rows, from the starter prepare_app returns, and shared it with Riley
 * but not with Jo. Sam and Riley each have the real app open in headless
 * Chrome. The artifact's rows live in Den's local storage backend.
 */
export async function artifactStorageWorld(seed: Seed) {
  const [teammatePort] = await allocateFreePorts(1);
  if (!teammatePort) throw new Error("No port for the teammate's app.");
  const { den, webPort } = await denForAppWeb(seed, {
    trustedOrigins: [`http://127.0.0.1:${teammatePort}`],
    env: {
      DEN_DEPLOYMENT: "cloud",
      DEN_APP_MCP_SERVERS_ENABLED: "true",
      DEN_DASHBOARDS_ENABLED: "true",
      DEN_ARTIFACT_STORAGE_BACKEND: "local",
      DEN_ARTIFACT_STORAGE_LOCAL_DIR: seed.tmpPath("artifact-storage-data"),
      OPENWORK_DEV_MODE: "1",
    },
    org: {
      name: `Requests Lab ${Date.now()}`,
      admin: { name: "Avery Admin" },
      members: { owner: { name: "Sam Owner" }, teammate: { name: "Riley Teammate" }, outsider: { name: "Jo Outsider" } },
    },
  });
  const owner = den.members.owner;
  const teammate = den.members.teammate;
  const outsider = den.members.outsider;
  if (!owner || !teammate || !outsider) throw new Error("The seeded organization is missing a member.");
  const organizationId = await seededOrganizationId(seed, den.admin);
  if (!organizationId) throw new Error("Could not resolve the seeded organization.");
  type Member = typeof owner;

  async function setSavedData(enabled: boolean) {
    const result = await seed.api(den.admin, `/v1/admin/organizations/${organizationId}/capabilities`, {
      method: "PUT",
      body: JSON.stringify({ capabilities: { artifactStorage: enabled } }),
    });
    if (!result.response.ok) throw new Error(`Setting artifact storage failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }

  async function token(member: Member) {
    const response = await seed.api(member, "/v1/mcp/token", {
      method: "POST", headers: { "x-openwork-org-id": organizationId },
      body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }),
    });
    const minted = stringField(response.body, "token");
    if (!response.response.ok || !minted) throw new Error(`Minting an MCP token failed: HTTP ${response.response.status}`);
    return minted;
  }

  let rpcId = 0;
  /** One MCP request as a client makes it: the result, or the JSON-RPC error. */
  async function rpc(bearer: string | null, path: string, method: string, params: Record<string, unknown>) {
    const response = await fetch(`${den.ref.apiUrl}${path}`, {
      method: "POST",
      headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
      signal: AbortSignal.timeout(120_000),
    });
    const raw = await response.text();
    const data = raw.split("\n").find((line) => line.startsWith("data:"));
    const message: unknown = JSON.parse(data ? data.slice(5) : raw);
    const result = isRecord(message) && isRecord(message.result) ? message.result : null;
    const error = isRecord(message) && isRecord(message.error) ? message.error : null;
    const text = records(result?.content).map((part) => stringField(part, "text")).join("");
    let body: unknown = null;
    try { body = JSON.parse(text); } catch { body = text; }
    return {
      status: response.status,
      structured: isRecord(result?.structuredContent) ? result.structuredContent : null,
      isError: result?.isError === true,
      errorCode: error ? stringField(error.data, "error") || stringField(error, "message") : isRecord(body) ? stringField(body, "error") : "",
      tools: records(result?.tools).map((tool) => stringField(tool, "name")),
      raw,
    };
  }

  await setSavedData(true);
  const ownerToken = await token(owner);
  const title = "Equipment requests";
  const description = "Ask for equipment and see what the team has asked for.";
  const prepared = await rpc(ownerToken, "/mcp/agent", "tools/call", { name: "prepare_app", arguments: { title, description, storage: STORAGE } });
  const starter = isRecord(prepared.structured?.starter) ? prepared.structured.starter : null;
  const reactSource = stringField(starter, "reactSource");
  if (!reactSource) throw new Error(`prepare_app returned no starter: ${prepared.raw.slice(0, 600)}`);
  const built = await rpc(ownerToken, "/mcp/agent", "tools/call", {
    name: "create_app",
    arguments: {
      title, description, storage: STORAGE, reactSource, cssSource: stringField(starter, "cssSource"),
      textFallback: "Equipment requests the team has saved.", preparationId: stringField(prepared.structured, "preparationId"),
    },
  });
  const app = isRecord(built.structured?.app) ? built.structured.app : null;
  const appId = stringField(app, "appId");
  const pluginId = stringField(app, "pluginId");
  const resourceUri = stringField(app, "resourceUri");
  if (built.isError || !appId || !pluginId || !resourceUri) throw new Error(`create_app failed: ${built.raw.slice(0, 800)}`);
  const shared = await seed.api(owner, `/v1/plugins/${pluginId}/access`, {
    method: "POST", headers: { "x-openwork-org-id": organizationId },
    body: JSON.stringify({ orgMembershipId: await readCurrentOrganizationMemberId(teammate), role: "viewer" }),
  });
  if (!shared.response.ok) throw new Error(`Sharing the artifact failed: HTTP ${shared.response.status} ${shared.text.slice(0, 300)}`);
  await setSavedData(false);

  const ownerApp = await signedInAppWeb(seed, { den, webPort, as: "owner", workspacePath: seed.tmpPath("storage-owner") });
  const teammateApp = await signedInAppWeb(seed, { den, webPort: teammatePort, as: "teammate", workspacePath: seed.tmpPath("storage-teammate") });
  const appPath = `/mcp/agent/connections/${appId}`;

  return {
    owner: ownerApp.app, teammate: teammateApp.app,
    ownerName: "Sam Owner", teammateName: "Riley Teammate",
    title, resourceUri,
    setSavedData,
    /** The tools the artifact's own MCP server lists for its builder right now. */
    async artifactTools() {
      return (await rpc(await token(owner), appPath, "tools/list", {})).tools;
    },
    /** What a member who was never given the artifact gets when they ask for its rows. */
    async outsiderRead() {
      const answer = await rpc(await token(outsider), appPath, "tools/call", { name: "storage_read", arguments: { collection: "requests" } });
      return { error: answer.errorCode, rows: records(answer.structured?.rows).length };
    },
    /** What someone who is not signed in gets when they try to add a row at the artifact's public address. */
    async anonymousWrite() {
      const answer = await rpc(null, `/mcp/public/apps/${appId}`, "tools/call", { name: "storage_write", arguments: { collection: "requests", action: "insert", values: { item: "Anonymous" } } });
      return { error: answer.errorCode, isError: answer.isError };
    },
    /** The saved items as the artifact's builder reads them through its MCP server. */
    async savedItems() {
      const answer = await rpc(await token(owner), appPath, "tools/call", { name: "storage_read", arguments: { collection: "requests", orderBy: "createdAt", order: "asc" } });
      return records(answer.structured?.rows).map((row) => ({ item: stringField(row.values, "item"), by: stringField(row, "createdBy") }));
    },
    /** The CSV an organization admin, or a plain member, gets for the artifact's saved rows. */
    async exportCsv(as: "admin" | "member") {
      const result = await seed.api(as === "admin" ? den.admin : teammate, `/v1/mcp-apps/${appId}/storage/export?format=csv&collection=requests`, {
        headers: { "x-openwork-org-id": organizationId },
      });
      return { status: result.response.status, text: result.text };
    },
  };
}
