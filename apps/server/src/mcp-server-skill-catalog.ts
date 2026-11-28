import { createHash } from "node:crypto";
import { z } from "zod";

import { agentPermissionDenial, agentPermissionRulesOf } from "./agent-permission-engine.js";
import { isRecord, openMcpResourceReader, type McpFetch } from "./connect-mcp-transport.js";
import { memberMcpServerSlug, memberMcpServers, type MemberMcpServer, type MemberMcpServerOptions } from "./member-mcp-servers.js";
import { readGlobalRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import { externalFetch } from "./server-fetch.js";
import type { ServerConfig } from "./types.js";

export const MCP_SKILLS_EXTENSION_ID = "io.modelcontextprotocol/skills";
export const MCP_SERVER_SKILL_ID_PREFIX = "mcp-server-";

const CLIENT_NAME = "openwork-server-mcp-skills";
const LISTED_TTL_MS = 60_000;
const UNAVAILABLE_TTL_MS = 5 * 60_000;
const MAX_PAGES = 5;
const MAX_SERVER_SKILLS = 50;
const MAX_SKILLS = 150;
const MAX_BODY_BYTES = 256 * 1024;

const entrySchema = z.object({
  uri: z.string().min(1).max(2_048),
  frontmatter: z.object({
    name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64),
    description: z.string().min(1).max(4_096),
  }).passthrough(),
  resources: z.array(z.object({ uri: z.string(), digest: z.string().optional() }).passthrough()).max(500).optional(),
}).passthrough();
const pageSchema = z.object({
  skills: z.array(z.unknown()).max(1_000),
  nextCursor: z.string().min(1).max(4_096).optional(),
}).passthrough();

export type McpServerSkill = {
  id: string;
  server: string;
  name: string;
  description: string;
  uri: string;
  digest?: string;
};

export type McpServerSkillCatalog = { skills: McpServerSkill[]; blocked?: string };

export type McpServerSkillOptions = MemberMcpServerOptions;

type ServerEntry = MemberMcpServer;

const listed = new Map<string, { expiresAt: number; value: Promise<McpServerSkill[] | null> }>();

function serverKey(server: ServerEntry): string {
  return createHash("sha256").update(JSON.stringify([server.name, server.config])).digest("hex");
}

function sha256Digest(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

async function skillServers(config: ServerConfig, options: McpServerSkillOptions): Promise<{ servers: ServerEntry[]; blocked?: string }> {
  const rules = agentPermissionRulesOf((await readGlobalRuntimeOpencodeConfig(config)).managedPolicy);
  const blocked = agentPermissionDenial(rules, "mcp_skill", ["*"]);
  if (blocked) return { servers: [], blocked };
  return { servers: (await memberMcpServers(config, options)).servers };
}

async function openSkillsReader(server: ServerEntry, fetcher: McpFetch) {
  const reader = await openMcpResourceReader({
    config: server.config,
    fetcher,
    clientName: CLIENT_NAME,
    capabilities: { extensions: { [MCP_SKILLS_EXTENSION_ID]: {} } },
  }).catch(() => null);
  const extensions = reader?.serverCapabilities.extensions;
  return reader && isRecord(extensions) && isRecord(extensions[MCP_SKILLS_EXTENSION_ID]) ? reader : null;
}

async function listServerSkills(server: ServerEntry, fetcher: McpFetch): Promise<McpServerSkill[] | null> {
  const reader = await openSkillsReader(server, fetcher);
  if (!reader) return null;
  const skills = new Map<string, McpServerSkill>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = pageSchema.safeParse(await reader.request("skills/list", cursor ? { cursor } : {}));
    if (!result.success) return page === 0 ? null : [...skills.values()];
    for (const raw of result.data.skills) {
      const entry = entrySchema.safeParse(raw);
      if (!entry.success || skills.size >= MAX_SERVER_SKILLS) continue;
      const { uri, frontmatter, resources } = entry.data;
      const id = `${MCP_SERVER_SKILL_ID_PREFIX}${memberMcpServerSlug(server.name)}-${frontmatter.name}`;
      const digest = resources?.find((resource) => resource.uri === uri)?.digest;
      if (skills.has(id)) continue;
      skills.set(id, {
        id,
        server: server.name,
        name: frontmatter.name,
        description: frontmatter.description,
        uri,
        ...(digest && /^sha256:[a-f0-9]{64}$/.test(digest) ? { digest } : {}),
      });
    }
    if (!result.data.nextCursor || result.data.nextCursor === cursor) break;
    cursor = result.data.nextCursor;
  }
  return [...skills.values()];
}

async function cachedServerSkills(server: ServerEntry, fetcher: McpFetch): Promise<McpServerSkill[]> {
  const key = serverKey(server);
  const cached = listed.get(key);
  if (cached && cached.expiresAt > Date.now()) return (await cached.value) ?? [];
  const value = listServerSkills(server, fetcher).catch(() => null);
  const entry = { expiresAt: Date.now() + LISTED_TTL_MS, value };
  listed.set(key, entry);
  const skills = await value;
  if (skills === null) entry.expiresAt = Date.now() + UNAVAILABLE_TTL_MS;
  return skills ?? [];
}

export async function readMcpServerSkillCatalog(config: ServerConfig, options: McpServerSkillOptions = {}): Promise<McpServerSkillCatalog> {
  try {
    const { servers, blocked } = await skillServers(config, options);
    const fetcher = options.fetcher ?? externalFetch;
    const skills = (await Promise.all(servers.map((server) => cachedServerSkills(server, fetcher)))).flat().slice(0, MAX_SKILLS);
    return { skills, ...(blocked ? { blocked } : {}) };
  } catch {
    return { skills: [] };
  }
}

export async function readMcpServerSkillContent(config: ServerConfig, id: string, options: McpServerSkillOptions = {}): Promise<string | null> {
  try {
    const { servers } = await skillServers(config, options);
    const fetcher = options.fetcher ?? externalFetch;
    for (const server of servers) {
      const skill = (await cachedServerSkills(server, fetcher)).find((entry) => entry.id === id);
      if (!skill) continue;
      const reader = await openSkillsReader(server, fetcher);
      const body = reader ? await reader.read(skill.uri) : null;
      if (body === null || Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) return null;
      return skill.digest && sha256Digest(body) !== skill.digest ? null : body;
    }
    return null;
  } catch {
    return null;
  }
}

export function resetMcpServerSkillCatalogCacheForTests(): void {
  listed.clear();
}
