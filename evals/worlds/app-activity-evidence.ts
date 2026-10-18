import { randomUUID } from "node:crypto";
import { evaluate } from "@openwork/cdp";

declare global {
  interface Window { __appActivityFlicker?: { timer: number; tops: Array<number | null> } }
}
import type { Seed } from "@openwork/env";
import { configureProvider } from "./chat.ts";

const appId = "cob_00000000000000000000000000";
const revisionId = "cov_00000000000000000000000000";
const resourceUri = `ui://openwork/apps/${appId}/revisions/${revisionId}/index.html`;
const app = { appId, revisionId, pluginId: "plg_00000000000000000000000000", title: "Project board", description: null,
  textFallback: "The project board is saved.", toolName: "open_app", resourceUri, serverPath: `/mcp/agent/connections/${appId}`, tools: [] };
const launch = { connectionId: appId, toolName: "open_app", resourceUri, arguments: {} };
export const GUIDE_PROMPT = "Build a project board after reading its unavailable instructions.";
export const BUILD_PROMPT = "Save a project board and report the later script failure separately.";
export const SKILL_PROMPT = "Load the review instructions, check five sections, and summarize.";

/** Real app, native v2 engine, saved tool results, and deterministic MCP/model
 * responses. No renderer stores or synthetic message injection. */
export async function appActivityEvidence(seed: Seed) {
  const mock = seed.mock({ isolatedProcessEnv: true, allowUnauthenticatedMcp: true, tools: [
    { name: "get_skill", description: "Read a skill", delayMs: 700, inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      result: { isError: true, content: [{ type: "text", text: "The build instructions are unavailable. Request access before retrying." }] } },
    { name: "prepare_app", description: "Check App tools", delayMs: 500, inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
      result: { isError: true, content: [{ type: "text", text: "Tool permissions could not be checked. Review the selected tools." }] } },
    { name: "create_app", description: "Save an App", delayMs: 700, inputSchema: { type: "object", properties: { title: { type: "string" }, reactSource: { type: "string", maxLength: 200_000 } }, required: ["title"] },
      result: { content: [{ type: "text", text: JSON.stringify({ app, launch }) }], structuredContent: { app, launch }, _meta: { "openwork/mcpApp": launch } } },
    { name: "skill", description: "Load review instructions", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      result: { content: [{ type: "text", text: JSON.stringify({ name: "review", content: "---\nname: review\n---\nCheck every report section before summarizing." }) }] } },
  ], agentWorkloads: [
    { promptMarker: GUIDE_PROMPT, latestUserTurn: true, finalReply: "The instructions are unavailable; request access before retrying.", steps: [
      { tool: "execute", arguments: { code: 'return await tools["openwork"].get_skill({name:"build-an-app"});' } },
    ] },
    { promptMarker: BUILD_PROMPT, latestUserTurn: true, finalReply: "The project board was saved. The later script step failed.", steps: [
      { tool: "execute", arguments: { code: 'try { await tools["openwork"].prepare_app({title:"Project board"}); } catch (error) {} const prefix = "export default function Board(){return null;}\\n//"; const reactSource = prefix + "x".repeat(200000 - prefix.length); await tools["openwork"].create_app({title:"Project board", reactSource}); throw new Error("Later script failure");' } },
    ] },
    // Explicit MCP retrieval only; this is not proof of implicit native hydration.
    { promptMarker: SKILL_PROMPT, latestUserTurn: true, finalReply: "All five report sections were checked.", steps: [
      { tool: "execute", arguments: { code: 'return await tools["openwork"].skill({name:"review"});' } },
      ...Array.from({ length: 5 }, (_, index) => ({ tool: "shell", arguments: { command: `printf 'Section ${index + 1} checked\\n'`, description: "Check report section" } })),
    ] },
  ] });
  const token = randomUUID();
  const hostToken = randomUUID();
  const web = await seed.appWeb({ name: "app-activity-evidence", workspacePath: seed.tmpPath("app-activity-evidence"), engine: "v2", headless: true, mouse: true,
    env: { OPENWORK_TOKEN: token, OPENWORK_HOST_TOKEN: hostToken,
      ...(process.env.pnpm_config_verify_deps_before_run ? { pnpm_config_verify_deps_before_run: process.env.pnpm_config_verify_deps_before_run } : {}),
      ...(process.env.OPENWORK_OPENCODE2_BIN ? { OPENWORK_OPENCODE2_BIN: process.env.OPENWORK_OPENCODE2_BIN } : {}),
    }, mocks: { agent: mock } });
  await web.client.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  const workspace = await seed.workspace(web, web.workspaceRoot);
  const witness = web.mocks.agent!;
  await configureProvider(seed, web, workspace.workspaceId, "activity-proof", "report", {
    permission: { "*": "allow" },
    mcp: { openwork: { type: "remote", url: witness.mcpUrl, enabled: true, oauth: false } },
    provider: { "activity-proof": { npm: "@ai-sdk/openai-compatible", name: "Report model", options: { baseURL: `${witness.url}/v1`, apiKey: "sk-activity-proof" }, models: { report: { name: "Report model" } } } },
  }, "v2");
  const session = await seed.session(web, { title: "App activity" });
  return { app: web, workspace, session, toolCalls: () => witness.toolCalls(),
    // Read-only layout sampling from measure-chat-flicker, at a fixed 1280×900.
    // This observes DOM geometry; it does not write application state.
    armFlicker: () => evaluate(web.client, () => {
      if (window.__appActivityFlicker) clearInterval(window.__appActivityFlicker.timer);
      const state: { timer: number; tops: Array<number | null> } = { timer: 0, tops: [] };
      state.timer = window.setInterval(() => {
        const line = document.querySelector("[data-loading-message]");
        const top = line ? Math.round(line.getBoundingClientRect().top) : null;
        if (state.tops.at(-1) !== top) state.tops.push(top);
      }, 50);
      window.__appActivityFlicker = state;
    }),
    flicker: () => evaluate(web.client, () => {
      const state = window.__appActivityFlicker;
      if (!state) throw new Error("Layout sampling was not armed");
      clearInterval(state.timer);
      let upwardJumps = 0;
      for (let index = 1; index < state.tops.length; index++) {
        const before = state.tops[index - 1], after = state.tops[index];
        if (before !== null && before !== undefined && after !== null && after !== undefined && after < before) upwardJumps++;
      }
      return { upwardJumps, samples: state.tops, visibleSamples: state.tops.filter(top => top !== null).length };
    }),
    async savedMessages() {
      const response = await fetch(`${web.openworkUrl}/workspace/${workspace.workspaceId}/opencode2/api/session/${session.sessionId}/message`, {
        headers: { Authorization: `Bearer ${token}`, "x-openwork-host-token": hostToken }, signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Reading persisted native messages failed: ${response.status}`);
      return response.text();
    },
  };
}
