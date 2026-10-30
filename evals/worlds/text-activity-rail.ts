import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Seed } from "@openwork/env";
import { configureProvider } from "./chat.ts";
import { seededOrganizationId } from "./organization-capabilities.ts";
import { denForAppWeb, signedInAppWeb } from "./signed-in-app-web.ts";

export const RAIL_PROMPT = "Check my notes, add a summary, fix the pricing line and tell me who is in the organization.";
export const RAIL_REPLY = "Your notes are summarised and the pricing line is fixed. The release is tracked in";
export const PR_LINK_TEXT = "#5212 feat(server): add openwork-server web self-host command";
const PR_URL = "https://github.com/different-ai/openwork/pull/5212";
export const RAIL_THOUGHT = "The notes mention pricing once, so the summary should lead with it.";

function script(code: string) {
  return { tool: "execute", arguments: { code } };
}

/**
 * One member's agent doing a typical turn on OpenCode v2: local commands, a
 * file read, a write and an edit, a read that fails, an OpenWork app tool, an
 * OpenWork Cloud capability through Code Mode, a thought, and an answer that
 * links a GitHub pull request. Text-first activity (`textActivityRail`)
 * starts off for the organization so the same turn shows before and after;
 * `setTextRail` flips it through the platform-admin route /admin uses. The
 * composer's Agents list (`composerSubagentTracker`) stays on throughout:
 * the text-first rail is designed for the world where it ships to everyone.
 */
export async function textActivityRailWorld(seed: Seed) {
  const engine = "v2";
  const { den, webPort } = await denForAppWeb(seed, { org: { name: "Pricing team", admin: { name: "Robin Park" } } });
  const organizationId = await seededOrganizationId(seed, den.admin);
  if (!organizationId) throw new Error("The seeded organization is unavailable.");

  const tmp = seed.tmpPath("text-activity-rail");
  await mkdir(join(tmp, "notes"), { recursive: true });
  // The engine reads the workspace at its real path; a symlinked temp path is "not found".
  const workspacePath = await realpath(tmp);
  const brief = join(workspacePath, "notes", "brief.md");
  await writeFile(brief, "# Client brief\n\nIntroduce the old pricing.\nKeep it short.\n");

  const text = (value: unknown) => [{ type: "text" as const, text: JSON.stringify(value) }];
  const inputSchema = { type: "object", properties: { name: { type: "string" }, query: { type: "string" } } };
  const directory = { organization: { name: "Pricing team" }, members: [{ name: "Robin Park", role: "owner" }, { name: "Sam Taylor", role: "member" }] };
  const mock = seed.mock({ isolatedProcessEnv: true, allowUnauthenticatedMcp: true, tools: [
    { name: "execute_capability", description: "Run an OpenWork capability.", whenArguments: { name: "getOrg" }, inputSchema,
      result: { content: text(directory) } },
  ], agentWorkloads: [
    { promptMarker: RAIL_PROMPT, latestUserTurn: true, finalReasoning: RAIL_THOUGHT,
      finalReply: `${RAIL_REPLY} [${PR_LINK_TEXT}](${PR_URL}).`, steps: [
        { tool: "shell", arguments: { command: "ls -1 notes", description: "list the notes folder" } },
        { tool: "read", arguments: { filePath: brief, path: brief } },
        { tool: "shell", arguments: { command: "grep -c pricing notes/brief.md", description: "count pricing mentions" } },
        { tool: "write", arguments: { filePath: join(workspacePath, "notes", "summary.md"), content: "# Summary\n\n- Lead with pricing.\n- Keep it short.\n" } },
        { tool: "edit", arguments: { filePath: brief, oldString: "Introduce the old pricing.", newString: "Introduce the new pricing.\nMention the annual plan." } },
        { tool: "read", arguments: { filePath: join(workspacePath, "notes", "missing.md"), path: join(workspacePath, "notes", "missing.md") } },
        { tool: "openwork_query", arguments: { id: "session.search", args: { query: "pricing" } } },
        script(`return await tools["openwork"].execute_capability({ name: "getOrg" });`),
      ] },
  ] });

  const { app, workspace } = await signedInAppWeb(seed, {
    den, webPort, engine, name: "text-activity-rail", workspacePath, mocks: { agent: mock },
    env: process.env.OPENWORK_OPENCODE2_BIN ? { OPENWORK_OPENCODE2_BIN: process.env.OPENWORK_OPENCODE2_BIN } : {},
  });
  const witness = app.mocks.agent;
  if (!witness) throw new Error("The activity model witness did not start");
  await configureProvider(seed, app, workspace.workspaceId, "text-activity-rail-proof", "rail-agent", {
    permission: { "*": "allow" },
    mcp: { openwork: { type: "remote", url: witness.mcpUrl, enabled: true, oauth: false } },
    provider: { "text-activity-rail-proof": { npm: "@ai-sdk/openai-compatible", name: "Rail agent",
      options: { baseURL: `${witness.url}/v1`, apiKey: "sk-text-activity-rail-proof" }, models: { "rail-agent": { name: "Rail agent" } } } },
  }, engine);
  const session = await seed.session(app, { title: "Pricing notes" });
  const setTextRail = async (enabled: boolean) => {
    const result = await seed.api(den.admin, `/v1/admin/organizations/${organizationId}/capabilities`, {
      method: "PUT", body: JSON.stringify({ capabilities: { textActivityRail: enabled, composerSubagentTracker: true } }),
    });
    if (!result.response.ok) throw new Error(`Switching text-first activity failed: HTTP ${result.response.status}`);
  };
  await setTextRail(false);
  return { app, den, workspace, session, setTextRail, toolCalls: () => witness.toolCalls() };
}
