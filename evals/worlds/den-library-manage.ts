import { allocateFreePorts, connect, debuggerUrlFor, listTargets } from "@openwork/cdp";
import type { Surface } from "@openwork/cdp";
import { faultProxy as startFaultProxy } from "@openwork/env";
import type { DenSession } from "@openwork/behaviors";
import type { Place, Seed } from "@openwork/env";
import type { MockMcpTool } from "@openwork/labs";
import { isRecord, records, stringField } from "./library.ts";

const people = {
  sam: "Sam K.",
  maya: "Maya Chen",
  ana: "Ana Park",
  lee: "Lee Wong",
  noor: "Noor Haddad",
  omar: "Omar Diaz",
  tess: "Tess Morgan",
  kai: "Kai Brooks",
} as const;
type Person = keyof typeof people;

const teams = { Support: ["ana", "lee", "noor"], Sales: ["omar", "tess"] } satisfies Record<string, Person[]>;

const slackTools: MockMcpTool[] = [
  ["send_message", "Send a message to a channel or person"],
  ["search_messages", "Search messages across channels"],
  ["list_channels", "List the channels you can see"],
  ["read_thread", "Read every reply in a thread"],
].map(([name, description]) => ({
  name,
  description,
  inputSchema: { type: "object", properties: { query: { type: "string" } } },
  result: { content: [{ type: "text", text: "Done." }] },
}));

/**
 * One organization where Sam (a member) and an admin share connectors and
 * plugins. den-web's API traffic runs through a proxy fixed in front of
 * den-api before Den boots, which pins the connector catalog and discovery
 * answers, so the catalog's Slack entry points at a local mock that signs
 * people in and serves tools; no real provider is contacted.
 */
export async function denLibraryManage(seed: Seed, ctx: { place: Place }, options: { samHasSlack?: boolean; asAdmin?: boolean; adminStartPath?: string } = {}) {
  if (ctx.place.kind !== "local") throw new Error("This world fixes a local proxy in front of den-api before boot; run it on the local lane.");
  const [apiPort, webPort] = await allocateFreePorts(2);
  const denApiUrl = `http://127.0.0.1:${apiPort}`;
  const proxy = await startFaultProxy({ apiUrl: denApiUrl, webUrl: denApiUrl }, { place: ctx.place });
  const den = await seed.den({
    ports: { api: apiPort, web: webPort },
    org: {
      name: `Library and Manage ${Date.now()}`,
      admin: { name: "Riley Admin" },
      members: Object.fromEntries(Object.entries(people).map(([key, name]) => [key, { name }])),
    },
    env: { DEN_API_PUBLIC_URL: proxy.ref.webUrl },
    webApiBase: proxy.ref.webUrl,
    mocks: { slack: seed.mock({ tools: slackTools }), hubspot: seed.mock() },
  });

  const org = await seed.api(den.admin, "/v1/org");
  const members = isRecord(org.body) ? records(org.body.members) : [];
  const memberIds = Object.fromEntries(Object.entries(people).map(([key, name]) => {
    const member = members.find((entry) => isRecord(entry.user) && entry.user.name === name);
    const id = member && typeof member.id === "string" ? member.id : "";
    if (!id) throw new Error(`Could not resolve ${name}'s organization membership.`);
    return [key, id];
  }));
  const teamIds: Record<string, string> = {};
  for (const [name, keys] of Object.entries(teams)) {
    const created = await seed.api(den.admin, "/v1/teams", { method: "POST", body: JSON.stringify({ name }) });
    const id = stringField(isRecord(created.body) ? created.body.team : null, "id");
    if (!id) throw new Error(`Could not create the ${name} team: HTTP ${created.response.status} ${created.text.slice(0, 300)}`);
    const patched = await seed.api(den.admin, `/v1/teams/${encodeURIComponent(id)}`, {
      method: "PATCH", body: JSON.stringify({ memberIds: keys.map((key) => memberIds[key]) }),
    });
    if (!patched.response.ok) throw new Error(`Could not add ${name}'s members: HTTP ${patched.response.status}`);
    teamIds[name] = id;
  }

  const { slack, hubspot } = den.mocks;
  const presets = [
    { presetId: "slack", displayName: "Slack", description: "Messages and channels.", url: slack.mcpUrl, authType: "oauth" },
    { presetId: "hubspot", displayName: "HubSpot", description: "Contacts, deals and notes.", url: hubspot.mcpUrl, authType: "oauth" },
    { presetId: "notion", displayName: "Notion", description: "Pages and databases.", url: "https://notion.connector.test/mcp", authType: "oauth" },
    { presetId: "linear", displayName: "Linear", description: "Issues and projects.", url: "https://linear.connector.test/mcp", authType: "oauth" },
  ];
  await proxy.faults.status("/v1/mcp-connections/presets", 200, { times: 10_000, body: { presets } });
  // What Den reports for a server where each person signs in with their own account; no provider is contacted.
  await proxy.faults.status("/v1/mcp-connections/discover", 200, {
    times: 10_000,
    body: {
      status: "ready",
      server: { url: slack.mcpUrl, protocolVersion: "2025-06-18", initialize: "authentication_required" },
      authentication: { kind: "oauth", availableRegistrationMethods: ["dynamic"], recommendedRegistrationMethod: "dynamic" },
      tools: { visibility: "requires_auth" },
      manualRequirements: [],
    },
  });

  if (options.samHasSlack) {
    const created = await seed.api(den.members.sam, "/v1/mcp-connections", {
      method: "POST",
      body: JSON.stringify({
        name: "Slack",
        url: slack.mcpUrl,
        authType: "oauth",
        credentialMode: "per_member",
        access: { orgWide: false, memberIds: [memberIds.sam] },
      }),
    });
    if (!created.response.ok) throw new Error(`Sam could not add Slack: HTTP ${created.response.status} ${created.text.slice(0, 300)}`);
  }

  const viewport = { width: 1440, height: 1000 };
  const web = options.asAdmin
    ? await seed.web({ den, signedInAs: den.admin, startPath: options.adminStartPath ?? "/dashboard/mcp-connections", headless: true, viewport })
    : await seed.web({ den, signedInAs: den.members.sam, startPath: "/dashboard/library", headless: true, viewport });
  const denWebOrigin = new URL(den.ref.webUrl).origin;

  async function library(session: DenSession): Promise<{ type: string; name: string }[]> {
    const result = await seed.api(session, "/v1/me/library");
    if (!result.response.ok || !isRecord(result.body)) throw new Error(`Could not read the Library: HTTP ${result.response.status}`);
    return records(result.body.items).map((item) => ({ type: stringField(item, "type"), name: stringField(item, "name") }));
  }

  return Object.assign({
    den,
    web,
    proxy,
    slack,
    people,
    memberIds,
    teamIds,
    teamSize: (name: keyof typeof teams) => teams[name].length,
    /** True once the browser has been served the pinned catalog and discovery answers, never Den's real ones. */
    async servedPinnedCatalog(): Promise<boolean> {
      const log = await proxy.requestLog();
      const faulted = (path: string) => log.some((entry) => entry.path.startsWith(path) && entry.faulted);
      return faulted("/v1/mcp-connections/presets") && faulted("/v1/mcp-connections/discover");
    },
    /** Names in a person's My Library, straight from Den. */
    library,
    async location(): Promise<string> {
      const value = await seed.evalIn(web, () => window.location.pathname + window.location.search);
      if (typeof value !== "string") throw new Error("Expected the web location to be a string.");
      return value;
    },
    // TODO(primitive): probe should list accessible link names inside a container by testId.
    async sidebarLinks(): Promise<string[]> {
      const value = await seed.evalIn(web, () => Array.from(document.querySelectorAll<HTMLElement>('[data-testid="den-org-sidebar"] a')).map((a) => (a.textContent ?? "").trim()));
      return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
    },
    /** The sign-in tab Den opens next to the dashboard, once it exists. */
    async signInTab({ timeoutMs = 20_000 }: { timeoutMs?: number } = {}): Promise<Surface | null> {
      const startedAt = Date.now();
      while (true) {
        const target = (await listTargets(web.handle.cdpUrl)).find((entry) => (
          entry.type === "page" && entry.id !== web.client.targetId && !entry.url.startsWith(`${denWebOrigin}/dashboard`)
        ));
        if (target) return { handle: web.handle, client: await connect(debuggerUrlFor(web.handle.cdpUrl, target)) };
        if (Date.now() - startedAt >= timeoutMs) return null;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    },
    async openAs(person: Person, startPath: string) {
      return seed.web({ den, signedInAs: den.members[person], startPath, headless: true, viewport });
    },
  }, {
    async [Symbol.asyncDispose]() {
      await proxy[Symbol.asyncDispose]();
    },
  });
}

/** The same organization after Sam has added Slack for himself. */
export const denLibraryWithSamsSlack = (seed: Seed, ctx: { place: Place }) => denLibraryManage(seed, ctx, { samHasSlack: true });

/** The same organization, with the admin signed in on Manage › Connectors. */
export const denManageAsAdmin = (seed: Seed, ctx: { place: Place }) => denLibraryManage(seed, ctx, { asAdmin: true });

/** The same organization, with the admin signed in on Manage › Plugins. */
export const denManagePluginsAsAdmin = (seed: Seed, ctx: { place: Place }) => denLibraryManage(seed, ctx, { asAdmin: true, adminStartPath: "/dashboard/plugins" });
