import { createOrgConnection, createPluginWithSkill, denFetch } from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import { mcpMock, resolvePlace, server } from "@openwork/testkit/stack";
import type { Den, MockBoot, Place } from "@openwork/testkit/stack";
import { provider } from "./ctx.ts";
import type { Provider } from "./ctx.ts";

export interface OrgFixture {
  name: string;
  admin: { name: string; email: string };
  capabilities: Record<string, boolean>;
  plugins: readonly {
    name: string;
    description: string;
    skillName: string;
    skillDescription: string;
    skillBody: string;
  }[];
  connections: readonly {
    name: string;
    mock: string;
  }[];
}

/** Docs-grade organization content: realistic names and no eval vocabulary. */
export const ORG_FIXTURE = {
  name: "Acme Robotics",
  admin: { name: "Alex Rivera", email: "alex@acme.dev" },
  capabilities: { workflows: true, mcpConnections: true, cloud: true },
  plugins: [
    {
      name: "Customer Research",
      description: "Prepare for sales calls with a structured company brief.",
      skillName: "customer-research",
      skillDescription: "Research a company and summarize key facts before a sales call.",
      skillBody: "# Instructions\n\n1. Gather the company's product, size, and recent news.\n2. Summarize the three facts that matter for this call.\n3. Suggest one opening question.",
    },
    {
      name: "Weekly Status Report",
      description: "Draft the weekly status update from recent activity.",
      skillName: "weekly-status-report",
      skillDescription: "Draft the weekly status update from this week's activity.",
      skillBody: "# Instructions\n\n1. Collect what shipped, what slipped, and what is blocked.\n2. Write a five-line update in the team's usual format.",
    },
    {
      name: "Meeting Notes",
      description: "Turn a transcript into structured meeting notes.",
      skillName: "meeting-notes",
      skillDescription: "Turn a meeting transcript into decisions, owners, and follow-ups.",
      skillBody: "# Instructions\n\n1. Extract decisions, owners, and deadlines from the transcript.\n2. List open questions at the end.",
    },
  ],
  connections: [{ name: "Slack", mock: "slack" }],
} as const satisfies OrgFixture;

export interface SeededOrg {
  den: Den;
  place: Place;
  orgId: string;
  /** Plugin ids in the order of the fixture's plugins. */
  pluginIds: string[];
  mcpToken: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readOrganizationId(admin: DenSession): Promise<string> {
  const { response, body, text } = await denFetch(admin, "/v1/me/orgs", {
    headers: { authorization: `Bearer ${admin.token}` },
  });
  const orgs = isRecord(body) && Array.isArray(body.orgs) ? body.orgs.filter(isRecord) : [];
  const id = orgs[0] && typeof orgs[0].id === "string" ? orgs[0].id : "";
  if (!response.ok || !id) throw new Error(`Resolving the organization failed: HTTP ${response.status} ${text.slice(0, 300)}`);
  return id;
}

async function mintMcpToken(admin: DenSession, orgId: string): Promise<string> {
  const { response, body, text } = await denFetch(admin, "/v1/mcp/token", {
    method: "POST",
    headers: { authorization: `Bearer ${admin.token}`, "x-openwork-org-id": orgId },
    body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }),
  });
  const token = isRecord(body) && typeof body.token === "string" ? body.token : "";
  if (!response.ok || !token) throw new Error(`Minting an MCP token failed: HTTP ${response.status} ${text.slice(0, 300)}`);
  return token;
}

/** Apply all user-visible fixture data to an already booted organization. */
export async function seedOrg(den: Den, data: OrgFixture): Promise<Omit<SeededOrg, "place">> {
  const orgId = await readOrganizationId(den.admin);
  const capabilities = await denFetch(den.admin, `/v1/admin/organizations/${orgId}/capabilities`, {
    method: "PUT",
    headers: { authorization: `Bearer ${den.admin.token}` },
    body: JSON.stringify({ capabilities: data.capabilities }),
  });
  if (!capabilities.response.ok) {
    throw new Error(`Enabling org capabilities failed: HTTP ${capabilities.response.status} ${capabilities.text.slice(0, 300)}`);
  }
  const pluginIds: string[] = [];
  for (const plugin of data.plugins) {
    const created = await createPluginWithSkill(den.admin, plugin);
    pluginIds.push(created.id);
  }
  for (const connection of data.connections) {
    const mock = den.mocks[connection.mock];
    if (!mock) throw new Error(`The ${connection.mock} MCP mock was not provisioned.`);
    await createOrgConnection(den.admin, {
      name: connection.name,
      url: mock.mcpUrl,
      authType: "oauth",
      credentialMode: "per_member",
      access: { orgWide: true },
    });
  }
  return { den, orgId, pluginIds, mcpToken: await mintMcpToken(den.admin, orgId) };
}

export function organization(data: OrgFixture): Provider<SeededOrg> {
  return provider(async (ctx) => {
    const place = resolvePlace(process.env);
    const mocks: Record<string, MockBoot> = {};
    for (const connection of data.connections) mocks[connection.mock] = mcpMock();
    const den = await server({ place, org: { name: data.name, admin: data.admin }, mocks });
    ctx.onDispose(() => den[Symbol.asyncDispose]());
    return { ...(await seedOrg(den, data)), place };
  });
}

export const org = organization(ORG_FIXTURE);
