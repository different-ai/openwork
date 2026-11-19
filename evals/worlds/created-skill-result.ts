import type { Seed } from "@openwork/env";
import { configureProvider } from "./chat.ts";
import { isRecord, records, stringField } from "./library.ts";
import { denForAppWeb, signedInAppWeb } from "./signed-in-app-web.ts";

export const SKILL_NAME = "Update CRM";
export const CREATE_PROMPT = "Create a new skill for this and share it with Sam.";
export const CREATE_REPLY = "Created a reusable skill for adding clients and deals to your CRM.";
export const BLOCKED_PROMPT = "Create the CRM skill again and share it with everyone.";
export const BLOCKED_REPLY = "The skill was created. Your organization does not let you share it with everyone.";
/** How long the share answer is held, so the running state can be seen. */
const SHARE_DELAY_MS = 9_000;

const SKILL_MARKDOWN = "---\nname: update-crm\ndescription: Add a new client and their deal to the CRM.\n---\n\n1. Find the client by name.\n2. Add them if they are new.\n3. Add the deal with its amount, stage and owner.";

function script(call: string) {
  // One OpenWork call per script, so each step is its own row on the rail.
  return { tool: "execute", arguments: { code: `return await tools["openwork"].${call};` } };
}

/**
 * A real skill, teammate and grant in Den, and the exact responses Den gave,
 * so a mock OpenWork tool can answer with them and the chat, the card and
 * Library describe the same object.
 */
export async function seedSharedSkill(seed: Seed, den: Awaited<ReturnType<typeof denForAppWeb>>["den"]) {
  const directory = await seed.api(den.admin, "/v1/org");
  if (!directory.response.ok) throw new Error(`Reading the organization failed: ${directory.text}`);
  const sam = (isRecord(directory.body) ? records(directory.body.members) : [])
    .find((member) => isRecord(member.user) && member.user.name === "Sam Taylor");
  const samId = stringField(sam, "id");
  if (!samId) throw new Error("The teammate is missing from the organization.");

  const created = await seed.api(den.admin, "/v1/plugins", {
    method: "POST", body: JSON.stringify({ name: SKILL_NAME, components: [{ type: "skill", input: { rawSourceText: SKILL_MARKDOWN } }] }),
  });
  const pluginId = stringField(isRecord(created.body) ? created.body.item : null, "id");
  if (!created.response.ok || !pluginId) throw new Error(`Creating the skill failed: ${created.text}`);
  const files = await seed.api(den.admin, `/v1/plugins/${encodeURIComponent(pluginId)}/config-objects`);
  const skillId = (isRecord(files.body) ? records(files.body.items) : [])
    .map((item) => stringField(item, "configObjectId") ?? stringField(isRecord(item.configObject) ? item.configObject : null, "id"))
    .find((id): id is string => Boolean(id));
  if (!skillId) throw new Error(`Reading the skill failed: ${files.text}`);
  const grant = await seed.api(den.admin, `/v1/plugins/${encodeURIComponent(pluginId)}/access`, {
    method: "POST", body: JSON.stringify({ orgMembershipId: samId, role: "viewer" }),
  });
  if (!grant.response.ok) throw new Error(`Sharing the skill failed: ${grant.text}`);

  const saved = { schemaVersion: "1", name: SKILL_NAME, pluginId, skillId, description: "Add a new client and their deal to the CRM.", libraryUrl: null };
  return { directory: directory.body, grant: grant.body, samId, pluginId, skillId, saved, skillMarkdown: SKILL_MARKDOWN };
}

/** The org every skill world uses: fictional people only. */
export const SKILL_ORG = { name: "Sales studio", admin: { name: "Alex Lee" }, members: { sam: { name: "Sam Taylor" } } };

/**
 * A signed-in member whose agent saves a skill in OpenWork Cloud and shares
 * it with a teammate. The skill, the teammate and the grant are real Den
 * records; the agent's OpenWork tools answer with exactly what Den returned
 * for them, so the chat, the card and Library describe the same object.
 * Engine v2 with Code Mode, as the product ships.
 */
export async function createdSkillResultWorld(seed: Seed) {
  const engine = "v2";
  const { den, webPort } = await denForAppWeb(seed, {
    org: SKILL_ORG,
  });

  const { directory, grant, samId, pluginId, skillId, saved } = await seedSharedSkill(seed, den);
  const text = (value: unknown) => [{ type: "text" as const, text: JSON.stringify(value) }];
  const providerId = "created-skill-proof";
  const modelId = "skill-agent";
  const createStep = script(`create_skill(${JSON.stringify({ pluginName: SKILL_NAME, skillMarkdown: SKILL_MARKDOWN })})`);
  const mock = seed.mock({ isolatedProcessEnv: true, allowUnauthenticatedMcp: true, tools: [
    { name: "create_skill", description: "Create one private OpenWork Cloud skill in a new Plugin.",
      inputSchema: { type: "object", properties: { pluginName: { type: "string" }, skillMarkdown: { type: "string" } }, required: ["pluginName", "skillMarkdown"] },
      result: { content: [{ type: "text", text: `# Skill created: ${SKILL_NAME}` }], structuredContent: saved, _meta: { schemaVersion: "1", pluginId, skillId } } },
    // Native API capabilities answer with the route's JSON as text, as Den's execute_capability does.
    { name: "execute_capability", description: "Run an OpenWork capability.", whenArguments: { name: "getOrg" },
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      result: { content: text(directory) } },
    { name: "execute_capability", description: "Run an OpenWork capability.", whenArguments: { name: "postPluginsAccess", body: { orgWide: true } },
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      result: { isError: true, content: text({ error: "forbidden", message: "Only organization admins can share with everyone." }) } },
    { name: "execute_capability", description: "Run an OpenWork capability.", whenArguments: { name: "postPluginsAccess" }, delayMs: SHARE_DELAY_MS,
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      result: { content: text(grant) } },
  ], agentWorkloads: [
    { promptMarker: CREATE_PROMPT, latestUserTurn: true, finalReply: CREATE_REPLY, steps: [
      createStep,
      script(`execute_capability({ name: "getOrg" })`),
      script(`execute_capability(${JSON.stringify({ name: "postPluginsAccess", path: { pluginId }, body: { orgMembershipId: samId, role: "viewer" } })})`),
    ] },
    { promptMarker: BLOCKED_PROMPT, latestUserTurn: true, finalReply: BLOCKED_REPLY, steps: [
      createStep,
      script(`execute_capability(${JSON.stringify({ name: "postPluginsAccess", path: { pluginId }, body: { orgWide: true, role: "viewer" } })})`),
    ] },
  ] });

  const { app, workspace } = await signedInAppWeb(seed, {
    den, webPort, engine, name: "created-skill-result", workspacePath: seed.tmpPath("created-skill-result"), mocks: { agent: mock },
    env: process.env.OPENWORK_OPENCODE2_BIN ? { OPENWORK_OPENCODE2_BIN: process.env.OPENWORK_OPENCODE2_BIN } : {},
  });
  const witness = app.mocks.agent;
  if (!witness) throw new Error("The skill model witness did not start");
  await configureProvider(seed, app, workspace.workspaceId, providerId, modelId, {
    permission: { "*": "allow" },
    mcp: { openwork: { type: "remote", url: witness.mcpUrl, enabled: true, oauth: false } },
    provider: { [providerId]: { npm: "@ai-sdk/openai-compatible", name: "Skill agent",
      options: { baseURL: `${witness.url}/v1`, apiKey: "sk-created-skill-proof" }, models: { [modelId]: { name: "Skill agent" } } } },
  }, engine);
  const session = await seed.session(app, { title: "Add a client to the CRM" });
  return { app, den, workspace, session, pluginId, skillId, toolCalls: () => witness.toolCalls() };
}
