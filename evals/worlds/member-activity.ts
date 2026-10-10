import { createDesktopHandoffGrant, denFetch, signInDesktopAs, type DenSession } from "@openwork/behaviors";
import { readActiveWorkspaceId } from "@openwork/cdp";
import type { Seed } from "@openwork/env";
import { isRecord } from "./openwork-server-cli.ts";

const names = {
  baseline: "Starting notes",
  provider: "Team model",
  plugin: "Team toolkit",
  skill: "eng-278-briefing",
  connection: "Team notes",
};

function field(value: unknown, key: string): string {
  const result = isRecord(value) ? value[key] : undefined;
  if (typeof result !== "string" || !result) throw new Error(`ENG-278 fixture response is missing ${key}`);
  return result;
}

function rows(value: unknown, key: string): Record<string, unknown>[] {
  const result = isRecord(value) ? value[key] : undefined;
  if (!Array.isArray(result)) throw new Error(`ENG-278 fixture response is missing ${key}`);
  return result.filter(isRecord);
}

/**
 * Real Den + real app-web. Only the external model/MCP service is a mock.
 * The fault proxy records the app's HTTP reads (not our administrative calls).
 * Remote grant/revoke operations use ordinary Den APIs and never touch the
 * renderer, Activity storage, its events, or its snapshot computation.
 */
export async function memberActivity(seed: Seed) {
  const den = await seed.den({
    web: false,
    org: {
      name: `ENG-278 Activity ${Date.now()}`,
      admin: { name: "ENG-278 administrator" },
      members: { recipient: { name: "ENG-278 member A" }, other: { name: "ENG-278 member B" } },
    },
    mocks: { service: seed.mock({ allowUnauthenticatedMcp: true }) },
  });
  const recipient = den.members.recipient;
  const other = den.members.other;
  const service = den.mocks.service;
  if (!recipient || !other || !service) throw new Error("ENG-278 members and external service were not provisioned");

  const org = await denFetch(recipient, "/v1/org", { headers: { authorization: `Bearer ${recipient.token}` } });
  if (!org.response.ok || !isRecord(org.body)) throw new Error(`Reading the member's organization failed: HTTP ${org.response.status}`);
  const organizationId = field(org.body.organization, "id");
  const membershipId = field(org.body.currentMember, "id");

  const api = async (session: DenSession, path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${session.token}`);
    headers.set("x-openwork-org-id", organizationId);
    const result = await denFetch(session, path, { ...init, headers });
    if (!result.response.ok) throw new Error(`ENG-278 ${init.method ?? "GET"} ${path}: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
    return result;
  };

  // Library's catalog read lazily provisions starter plugins. Complete that
  // ordinary setup before the first baseline, rather than mixing it into the
  // four explicit grants this journey measures.
  await api(den.admin, "/v1/marketplaces");

  // A nonempty first inventory must still be silent: this is not an empty-org
  // shortcut. Both members can use this connection before Activity first syncs.
  const starting = await api(den.admin, "/v1/mcp-connections/by-key/eng-278-starting-notes", {
    method: "PUT",
    body: JSON.stringify({ name: names.baseline, url: service.mcpUrl, authType: "none", credentialMode: "shared", access: { orgWide: true } }),
  });
  const baselineId = field(starting.body, "id");
  // Proxy the API directly: the web server redirects /api/den to another
  // origin, which causes a browser to drop the member's bearer token.
  const proxy = await seed.faultProxy({ ...den, ref: { ...den.ref, webUrl: den.ref.apiUrl } });
  const workspacePath = seed.tmpPath("eng-278-member-activity");
  const app = await seed.appWeb({
    name: "eng-278-member-activity", workspacePath, headless: true,
    env: {
      OPENWORK_DEV_HEADLESS_WEB_DEN_PROXY: "1",
      OPENWORK_DEV_DEN_PROXY_TARGET: den.ref.webUrl,
      OPENWORK_DEV_HEADLESS_DEN_API_TARGET: proxy.ref.webUrl,
      VITE_DEN_BASE_URL: den.ref.webUrl,
      VITE_DEN_API_BASE_URL: "/api/den",
    },
  });
  const authTarget = { ...den.ref, apiUrl: `${app.webUrl}/api/den` };
  // Match the three Paper Activity artboards for visual comparison.
  await app.client.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  try {
    await signInDesktopAs(app, authTarget, recipient);
  } catch (error) {
    const requests = await proxy.requestLog();
    throw new Error(`ENG-278 sign-in failed; API responses: ${JSON.stringify(requests.map(({ method, path, status }) => ({ method, path, status })))}`, { cause: error });
  }
  // appWeb already bootstraps this workspace. The desktop workspace helper
  // waits for a hash route, whereas this surface uses BrowserRouter.
  const workspaceId = await readActiveWorkspaceId(app.client);
  if (!workspaceId) throw new Error("ENG-278 app-web workspace is not selected");
  const workspace = { workspaceId };
  let published: { providerId: string; pluginId: string; connectionId: string } | null = null;

  return {
    app, workspace, names, baselineId,
    /** BrowserRouter URL, read through CDP without evaluating application code. */
    async location() {
      const history = await app.client.send("Page.getNavigationHistory");
      if (!isRecord(history) || typeof history.currentIndex !== "number" || !Array.isArray(history.entries)) {
        throw new Error("ENG-278 browser navigation history is unavailable");
      }
      const current: unknown = history.entries[history.currentIndex];
      return new URL(field(current, "url")).pathname;
    },
    /** These sessions stay fixture-private; evidence never prints tokens. */
    emails: { recipient: recipient.email, other: other.email, admin: den.admin.email },
    async handoff(person: "recipient" | "other" | "admin") {
      const session = person === "recipient" ? recipient : person === "other" ? other : den.admin;
      return { grant: await createDesktopHandoffGrant(session), baseUrl: authTarget.webUrl, apiBaseUrl: authTarget.apiUrl };
    },
    async publishForRecipient() {
      if (published) throw new Error("ENG-278 resources were already published");
      const model = await api(den.admin, "/v1/llm-providers", {
        method: "POST",
        body: JSON.stringify({
          name: names.provider, source: "custom", allMembers: false, memberIds: [membershipId], teamIds: [],
          customConfig: {
            id: "eng-278-model", name: names.provider, npm: "@ai-sdk/openai-compatible",
            options: { baseURL: `${service.url}/v1` }, env: ["ENG_278_MODEL_API_KEY"],
            models: [{ id: "eng-278-model", name: names.provider, tool_call: true }],
          },
          apiKey: "sk-eng-278-fixture-only",
        }),
      });
      const providerId = field(isRecord(model.body) ? model.body.llmProvider : undefined, "id");
      const marketplace = await api(den.admin, "/v1/marketplaces", {
        method: "POST", body: JSON.stringify({ name: "ENG-278 shared tools" }),
      });
      const marketplaceId = field(isRecord(marketplace.body) ? marketplace.body.item : undefined, "id");
      const marketplaceGrant = await api(den.admin, `/v1/marketplaces/${encodeURIComponent(marketplaceId)}/access`, {
        method: "POST", body: JSON.stringify({ orgMembershipId: membershipId, role: "viewer" }),
      });
      const plugin = await api(den.admin, "/v1/plugins", {
        method: "POST",
        body: JSON.stringify({
          name: names.plugin, orgWide: false, marketplaceId,
          components: [{ type: "skill", input: {
            rawSourceText: `---\nname: ${names.skill}\ndescription: Turn supplied notes into a short briefing.\n---\n\nSummarize the notes into decisions and next steps.`,
            metadata: { name: names.skill, description: "Turn supplied notes into a short briefing." },
          } }],
        }),
      });
      const pluginId = field(isRecord(plugin.body) ? plugin.body.item : undefined, "id");
      const grant = await api(den.admin, `/v1/plugins/${encodeURIComponent(pluginId)}/access`, {
        method: "POST", body: JSON.stringify({ orgMembershipId: membershipId, role: "viewer" }),
      });
      const connection = await api(den.admin, "/v1/mcp-connections/by-key/eng-278-team-notes", {
        method: "PUT",
        body: JSON.stringify({
          name: names.connection, url: service.mcpUrl, authType: "none", credentialMode: "shared",
          access: { orgWide: false, memberIds: [membershipId], teamIds: [] },
        }),
      });
      published = { providerId, pluginId, connectionId: field(connection.body, "id") };
      return { ...published, statuses: [model.response.status, marketplace.response.status, marketplaceGrant.response.status, plugin.response.status, grant.response.status, connection.response.status] };
    },
    async updateBriefing() {
      if (!published) throw new Error("ENG-278 toolkit has not been published");
      const resolved = await api(den.admin, `/v1/plugins/${encodeURIComponent(published.pluginId)}/resolved`);
      const skill = rows(resolved.body, "items").map((entry) => entry.configObject)
        .filter(isRecord).find((entry) => entry.objectType === "skill");
      const skillId = field(skill, "id");
      const result = await api(den.admin, `/v1/config-objects/${encodeURIComponent(skillId)}/versions`, {
        method: "POST", body: JSON.stringify({
          input: {
            rawSourceText: `---\nname: ${names.skill}\ndescription: Turn supplied notes into a short briefing.\n---\n\nSummarize the notes into decisions, next steps, and open questions.`,
            metadata: { name: names.skill, description: "Turn supplied notes into a short briefing." },
          },
          reason: "ENG-278 shared briefing update",
        }),
      });
      return { skillId, status: result.response.status };
    },
    async removeConnectionAccess() {
      if (!published) throw new Error("ENG-278 connection has not been published");
      const result = await api(den.admin, `/v1/mcp-connections/${encodeURIComponent(published.connectionId)}/access`, {
        method: "PUT", body: JSON.stringify({ access: { orgWide: false, memberIds: [], teamIds: [] } }),
      });
      return result.response.status;
    },
    /** A second witness, from Den rather than from Activity's local history. */
    async inventory(person: "recipient" | "other") {
      const session = person === "recipient" ? recipient : other;
      const [models, library, connections] = await Promise.all([
        api(session, "/v1/llm-providers"),
        api(session, "/v1/me/library"),
        api(session, "/v1/mcp-connections?scope=usable"),
      ]);
      return {
        providers: rows(models.body, "llmProviders").map((entry) => field(entry, "id")),
        library: library.body,
        connections: rows(connections.body, "connections").map((entry) => field(entry, "id")),
      };
    },
    /** Fault only inventory; authentication remains healthy and verified. */
    failInventory: () => proxy.faults.status("/v1/llm-providers", 503, {
      times: 100, body: { error: "eng_278_inventory_unavailable", message: "Inventory is temporarily unavailable." },
    }),
    recoverInventory: () => proxy.faults.clear(),
    requests: () => proxy.requestLog(),
  };
}
