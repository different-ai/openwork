import type { DenSession } from "@openwork/behaviors";
import type { Seed } from "@openwork/env";
import type { MockMcpTool } from "@openwork/labs";
import { enableOrganizationCapabilities } from "./dashboards.ts";
import { isRecord, records } from "./den-dashboard-activity.ts";

function field(value: unknown, key: string): string {
  const result = isRecord(value) ? value[key] : undefined;
  if (typeof result !== "string" || !result) throw new Error(`Library usage arrangement is missing ${key}.`);
  return result;
}

const skills = {
  draftReply: { plugin: "Support kit", name: "draft-reply", description: "Draft a reply to a customer ticket." },
  summarizeTicket: { plugin: "Support kit", name: "summarize-ticket", description: "Summarize a long ticket thread." },
  quoteBuilder: { plugin: "Sales kit", name: "quote-builder", description: "Build a price quote from a request." },
} as const;
type SkillKey = keyof typeof skills;

const trackerTools: MockMcpTool[] = [
  { name: "search_issues", description: "Search the team's issues.", inputSchema: { type: "object", properties: { query: { type: "string" } } }, result: { content: [{ type: "text", text: "3 issues found." }] } },
  { name: "create_issue", description: "Create an issue.", inputSchema: { type: "object", properties: { title: { type: "string" } } }, result: { content: [{ type: "text", text: "Project is archived." }], isError: true } },
];

/**
 * Real Den with Library usage on for one organization: an owner, two
 * teammates, three skills in two plugins, and two connectors served by a
 * local mock MCP server. Nothing is pre-counted; uses are created only when a
 * teammate's agent loads a skill or calls a connector tool through the real
 * OpenWork MCP gateway (`loadSkill`, `callConnector`), exactly as Codex or
 * Claude Code would.
 */
export async function libraryUsage(seed: Seed) {
  const den = await seed.den({
    org: {
      name: "Support team",
      admin: { name: "Usage Owner" },
      members: { alice: { name: "Alice Teammate" }, blair: { name: "Blair Teammate" } },
    },
    mocks: { tracker: seed.mock({ allowUnauthenticatedMcp: true, tools: trackerTools }) },
  });
  const orgId = await enableOrganizationCapabilities(seed, den.admin, { libraryUsage: true });
  const api = async (path: string, init: RequestInit = {}) => {
    const result = await seed.api(den.admin, path, init);
    if (!result.response.ok) throw new Error(`Library usage arrangement ${path}: HTTP ${result.response.status}: ${result.text.slice(0, 300)}`);
    return result.body;
  };

  const capabilities = {} as Record<SkillKey, { capability: string; title: string }>;
  for (const plugin of ["Support kit", "Sales kit"] as const) {
    const entries = Object.entries(skills).filter(([, skill]) => skill.plugin === plugin);
    const created = await api("/v1/plugins", {
      method: "POST",
      body: JSON.stringify({
        name: plugin, orgWide: true,
        components: entries.map(([, skill]) => ({ type: "skill", input: {
          rawSourceText: `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n${skill.description}`,
          metadata: { name: skill.name, description: skill.description },
        } })),
      }),
    });
    const pluginId = field(isRecord(created) ? created.item : undefined, "id");
    const resolved = await api(`/v1/plugins/${pluginId}/resolved`);
    const objects = records(isRecord(resolved) ? resolved.items : undefined).map((entry) => entry.configObject).filter(isRecord);
    for (const [key, skill] of entries) {
      const plain = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
      const object = objects.find((entry) => entry.objectType === "skill" && typeof entry.title === "string" && plain(entry.title) === plain(skill.name));
      if (!object) throw new Error(`Library usage arrangement could not find ${skill.name}.`);
      capabilities[key as SkillKey] = { capability: `plugin:${pluginId}:${field(object, "id")}`, title: field(object, "title") };
    }
  }

  const connectors = { tracker: "Team tracker", wiki: "Old wiki" } as const;
  const connectionIds = {} as Record<keyof typeof connectors, string>;
  for (const [key, name] of Object.entries(connectors) as [keyof typeof connectors, string][]) {
    const created = await api("/v1/mcp-connections", {
      method: "POST",
      body: JSON.stringify({ name, url: den.mocks.tracker.mcpUrl, authType: "none", credentialMode: "shared", access: { orgWide: true } }),
    });
    connectionIds[key] = field(created, "id");
  }

  const tokens = new Map<DenSession, string>();
  async function mcpToken(person: DenSession) {
    const known = tokens.get(person);
    if (known) return known;
    const minted = await seed.api(person, "/v1/mcp/token", { method: "POST", body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }) });
    const token = field(minted.body, "token");
    tokens.set(person, token);
    return token;
  }
  let requestId = 0;
  async function callTool(person: "alice" | "blair", name: string, args: Record<string, unknown>) {
    const session = den.members[person];
    if (!session) throw new Error(`Missing ${person}.`);
    const response = await fetch(`${den.ref.apiUrl}/mcp/agent`, {
      method: "POST",
      headers: { authorization: `Bearer ${await mcpToken(session)}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method: "tools/call", params: { name, arguments: args } }),
    });
    const raw = await response.text();
    const data = raw.split("\n").find((line) => line.startsWith("data:"));
    const payload: unknown = JSON.parse(data ? data.slice(5) : raw);
    const result = isRecord(payload) && isRecord(payload.result) ? payload.result : null;
    const content = result && Array.isArray(result.content) ? result.content.filter(isRecord) : [];
    return { status: response.status, isError: result?.isError === true, text: content.map((entry) => typeof entry.text === "string" ? entry.text : "").join("\n") };
  }

  /**
   * A teammate's agent loads one skill through the gateway. This is the
   * product action being measured (an agent using a skill), not a write to
   * the usage table; it returns what the agent received.
   */
  async function loadSkill(person: "alice" | "blair", key: SkillKey, tool: "get_skill" | "execute_capability") {
    const result = await callTool(person, tool, { name: capabilities[key].capability });
    return { ...result, servedSkill: result.text.includes(skills[key].description) };
  }

  /** A teammate's agent calls one connector tool through the gateway, as execute_capability does. */
  async function callConnector(person: "alice" | "blair", key: keyof typeof connectors, toolName: string) {
    return callTool(person, "execute_capability", { name: `mcp:${connectionIds[key]}:${toolName}`, body: {} });
  }

  const viewport = { width: 1280, height: 1000 };
  const web = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/analytics", headless: true, viewport });
  const memberWeb = await seed.web({ den, signedInAs: den.members.alice, startPath: "/dashboard", headless: true, viewport });
  return { den, web, memberWeb, orgId, skills: capabilities, connectors, loadSkill, callConnector, baseUrl: den.ref.webUrl };
}
