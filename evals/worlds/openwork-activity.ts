import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Seed } from "@openwork/env";
import { configureProvider } from "./chat.ts";
import { SKILL_NAME, SKILL_ORG, seedSharedSkill } from "./created-skill-result.ts";
import { denForAppWeb, signedInAppWeb } from "./signed-in-app-web.ts";

export const MIXED_PROMPT = "Tidy my chats, check my notes, and find who is in the organization.";
export const MIXED_REPLY = "Your chats are tidied, your notes are listed, and I found the people in your organization.";
export const SCRIPT_PROMPT = "Save the CRM steps as a skill for everyone, and clear out the Archive group.";
export const SCRIPT_REPLY = "The skill is saved for you. Sharing with everyone is blocked, and there is no Archive group to remove.";
export const EARLIER_CHAT = "Draft a client introduction";
export const GROUP_LABEL = "Done";
/** How long the directory lookup is held, so the running rail can be seen. */
const LOOKUP_DELAY_MS = 9_000;

function script(code: string) {
  return { tool: "execute", arguments: { code } };
}

/**
 * One member's agent using everything OpenWork gives it in a single
 * conversation: OpenWork's own app tools (context, chat search, sidebar
 * groups) against the real app, OpenWork Cloud discovery and API
 * capabilities through Code Mode, local commands and file reads, a created
 * skill, a share the organization blocks, and an OpenWork command that
 * refuses. The Cloud tools answer with exactly what a real Den returned for a
 * real skill, teammate and grant. Engine v2, as the product ships.
 */
export async function openworkActivityWorld(seed: Seed) {
  const engine = "v2";
  const { den, webPort } = await denForAppWeb(seed, { org: SKILL_ORG });
  const { directory, saved, skillMarkdown, pluginId, skillId } = await seedSharedSkill(seed, den);

  const tmp = seed.tmpPath("openwork-activity");
  await mkdir(join(tmp, "notes"), { recursive: true });
  // The engine reads the workspace at its real path; a symlinked temp path is "not found".
  const workspacePath = await realpath(tmp);
  await writeFile(join(workspacePath, "notes", "brief.md"), "# Client brief\n\nIntroduce the new pricing.\n");

  const text = (value: unknown) => [{ type: "text" as const, text: JSON.stringify(value) }];
  const inputSchema = { type: "object", properties: { name: { type: "string" }, query: { type: "string" } } };
  const mock = seed.mock({ isolatedProcessEnv: true, allowUnauthenticatedMcp: true, tools: [
    { name: "search_capabilities", description: "Search OpenWork Cloud capabilities.", inputSchema,
      result: { content: text({ matches: [{ name: "getOrg", method: "GET", path: "/v1/org", summary: "Read the organization directory." }] }) } },
    { name: "create_skill", description: "Create one private OpenWork Cloud skill in a new Plugin.", inputSchema,
      result: { content: [{ type: "text", text: `# Skill created: ${SKILL_NAME}` }], structuredContent: saved } },
    { name: "execute_capability", description: "Run an OpenWork capability.", whenArguments: { name: "getOrg" }, delayMs: LOOKUP_DELAY_MS, inputSchema,
      result: { content: text(directory) } },
    { name: "execute_capability", description: "Run an OpenWork capability.", whenArguments: { name: "postPluginsAccess" }, inputSchema,
      result: { isError: true, content: text({ error: "forbidden", message: "Only organization admins can share with everyone." }) } },
  ], agentWorkloads: [
    { promptMarker: MIXED_PROMPT, latestUserTurn: true, finalReply: MIXED_REPLY, steps: [
      { tool: "openwork_context", arguments: {} },
      { tool: "openwork_query", arguments: { id: "session.search", args: { query: "client introduction" } } },
      { tool: "openwork_execute", arguments: { id: "session.group.create", args: { label: GROUP_LABEL } } },
      { tool: "shell", arguments: { command: "ls -1", description: "List the workspace files" } },
      { tool: "read", arguments: { filePath: join(workspacePath, "notes", "brief.md"), path: join(workspacePath, "notes", "brief.md") } },
      script(`return await tools["openwork"].search_capabilities({ query: "organization people" });`),
      script(`return await tools["openwork"].execute_capability({ name: "getOrg" });`),
    ] },
    { promptMarker: SCRIPT_PROMPT, latestUserTurn: true, finalReply: SCRIPT_REPLY, steps: [
      script([
        `const skill = await tools["openwork"].create_skill(${JSON.stringify({ pluginName: SKILL_NAME, skillMarkdown })});`,
        `await tools["openwork"].execute_capability(${JSON.stringify({ name: "postPluginsAccess", path: { pluginId }, body: { orgWide: true, role: "viewer" } })});`,
        "return skill;",
      ].join("\n")),
      { tool: "openwork_execute", arguments: { id: "session.group.remove", args: { groupId: "Archive", confirmed: true } } },
    ] },
  ] });

  const { app, workspace } = await signedInAppWeb(seed, {
    den, webPort, engine, name: "openwork-activity", workspacePath, mocks: { agent: mock },
    env: process.env.OPENWORK_OPENCODE2_BIN ? { OPENWORK_OPENCODE2_BIN: process.env.OPENWORK_OPENCODE2_BIN } : {},
  });
  const witness = app.mocks.agent;
  if (!witness) throw new Error("The activity model witness did not start");
  await configureProvider(seed, app, workspace.workspaceId, "openwork-activity-proof", "activity-agent", {
    permission: { "*": "allow" },
    mcp: { openwork: { type: "remote", url: witness.mcpUrl, enabled: true, oauth: false } },
    provider: { "openwork-activity-proof": { npm: "@ai-sdk/openai-compatible", name: "Activity agent",
      options: { baseURL: `${witness.url}/v1`, apiKey: "sk-openwork-activity-proof" }, models: { "activity-agent": { name: "Activity agent" } } } },
  }, engine);
  // An earlier chat the agent finds by searching, and the one it works in.
  await seed.session(app, { title: EARLIER_CHAT });
  const session = await seed.session(app, { title: "Tidy up" });
  return { app, den, workspace, session, pluginId, skillId, toolCalls: () => witness.toolCalls() };
}
