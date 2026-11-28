import { readCurrentOrganizationMemberId } from "@openwork/behaviors";
import { evaluateOnSurface, type Surface } from "@openwork/cdp";
import type { Seed } from "@openwork/env";
import { isRecord, stringField } from "./library.ts";
import { seededOrganizationId } from "./organization-capabilities.ts";
import { denForAppWeb, signedInAppWeb } from "./signed-in-app-web.ts";

const storage = {
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

export async function artifactShareLinkWorld(seed: Seed) {
  const { den, webPort } = await denForAppWeb(seed, {
    schema: "migrate",
    env: {
      DEN_DEPLOYMENT: "cloud",
      DEN_APP_MCP_SERVERS_ENABLED: "true",
      DEN_DASHBOARDS_ENABLED: "true",
      DEN_ARTIFACT_STORAGE_BACKEND: "local",
      DEN_ARTIFACT_STORAGE_LOCAL_DIR: seed.tmpPath("artifact-share-link-data"),
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
  const webOrigin = new URL(den.ref.webUrl).origin;
  const apiOrigin = new URL(den.ref.apiUrl).origin;
  if (new URL(webOrigin).hostname !== new URL(apiOrigin).hostname) {
    throw new Error("This world needs Den web and Den API to share the session cookie hostname.");
  }

  async function setFeatures(artifactShareLinks: boolean) {
    const result = await seed.api(den.admin, `/v1/admin/organizations/${organizationId}/capabilities`, {
      method: "PUT",
      body: JSON.stringify({ capabilities: { artifactStorage: true, artifactShareLinks } }),
    });
    if (!result.response.ok) throw new Error(`Setting artifact features failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }

  await setFeatures(false);
  const minted = await seed.api(owner, "/v1/mcp/token", {
    method: "POST", headers: { "x-openwork-org-id": organizationId },
    body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }),
  });
  const token = stringField(minted.body, "token");
  if (!minted.response.ok || !token) throw new Error(`Minting the owner's MCP token failed: HTTP ${minted.response.status}`);

  let rpcId = 0;
  async function callTool(name: string, args: Record<string, unknown>) {
    const response = await fetch(`${apiOrigin}/mcp/agent`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
      signal: AbortSignal.timeout(120_000),
    });
    const raw = await response.text();
    const data = raw.split("\n").find((line) => line.startsWith("data:"));
    const message: unknown = JSON.parse(data ? data.slice(5) : raw);
    const result = isRecord(message) && isRecord(message.result) ? message.result : null;
    if (!response.ok || !result || result.isError || !isRecord(result.structuredContent)) {
      throw new Error(`${name} failed: HTTP ${response.status} ${raw.slice(0, 800)}`);
    }
    return result.structuredContent;
  }

  const title = "Equipment requests";
  const description = "Ask for equipment and see what the team has asked for.";
  const prepared = await callTool("prepare_app", { title, description, storage });
  const reactSource = stringField(prepared.starter, "reactSource");
  if (!reactSource) throw new Error("prepare_app returned no storage starter.");
  const built = await callTool("create_app", {
    title, description, storage, reactSource, cssSource: stringField(prepared.starter, "cssSource"),
    textFallback: "Equipment requests the team has saved.", preparationId: stringField(prepared, "preparationId"),
  });
  const appId = stringField(built.app, "appId");
  const pluginId = stringField(built.app, "pluginId");
  const resourceUri = stringField(built.app, "resourceUri");
  if (!appId || !pluginId || !resourceUri) throw new Error("create_app returned no artifact address.");
  const shared = await seed.api(owner, `/v1/plugins/${pluginId}/access`, {
    method: "POST", headers: { "x-openwork-org-id": organizationId },
    body: JSON.stringify({ orgMembershipId: await readCurrentOrganizationMemberId(teammate), role: "viewer" }),
  });
  if (!shared.response.ok) throw new Error(`Sharing the artifact failed: HTTP ${shared.response.status} ${shared.text.slice(0, 300)}`);

  const { app } = await signedInAppWeb(seed, { den, webPort, as: "owner", workspacePath: seed.tmpPath("artifact-share-owner") });
  const web = await seed.web({ den, startPath: "about:blank", headless: true });
  const artifactUrl = new URL("/artifact", webOrigin);
  artifactUrl.searchParams.set("id", appId);
  artifactUrl.searchParams.set("org", organizationId);
  const memberUrl = new URL(`/mcp/agent/connections/${appId}`, apiOrigin);
  memberUrl.searchParams.set("org", organizationId);

  return {
    app, web, title, appId, resourceUri, organizationId, webOrigin, apiOrigin, teammate, outsider,
    artifactUrl: artifactUrl.href, memberUrl: memberUrl.href,
    setFeatures,
    freshBrowser: () => seed.web({ den, startPath: "about:blank", headless: true }),
    currentUrl: (surface: Surface) => evaluateOnSurface(surface, () => location.href),
    signInHref: (surface: Surface) => evaluateOnSurface(surface, () => document.querySelector<HTMLAnchorElement>("#status a")?.href ?? null),
    async sessionCookie(surface: Surface) {
      const response: unknown = await surface.client.send("Network.getCookies", { urls: [webOrigin, apiOrigin] });
      const cookies = isRecord(response) && Array.isArray(response.cookies) ? response.cookies.filter(isRecord) : [];
      const cookie = cookies.find((entry) => typeof entry.name === "string" && entry.name.endsWith(".session_token"));
      return cookie ? { domain: cookie.domain, path: cookie.path, secure: cookie.secure, httpOnly: cookie.httpOnly } : null;
    },
  };
}
