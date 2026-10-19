import { addInitScript, browserScript, reload } from "@openwork/cdp";
import type { Seed } from "@openwork/env";
import { configureProvider } from "./chat.ts";
import { denForAppWeb, signedInAppWeb } from "./signed-in-app-web.ts";
import { seededOrganizationId } from "./organization-capabilities.ts";

type OfflineFault = {
  disconnected: boolean;
  prompts: number;
  stops: number;
  probes: number;
  views: number;
  setOffline(value: boolean): void;
};
declare global { interface Window { __offlineRecoveryFault?: OfflineFault } }

export const SAVED_PROMPT = "Keep this completed report in the conversation.";
export const SAVED_REPLY = "The completed report is preserved.";
export const MCP_PROMPT = "Prepare my report and update the client note.";
export const MCP_REPLY = "The report is saved; the note service timed out.";
export const APP_CONNECTION_ERROR = "Streamable HTTP POST: connection or protocol negotiation failed";

export async function offlineRecoveryWorld(seed: Seed) {
  const engine = "v2";
  const { den, webPort } = await denForAppWeb(seed);
  const organizationId = await seededOrganizationId(seed, den.admin);
  const providerId = "offline-proof";
  const modelId = "report";
  const mock = seed.mock({ isolatedProcessEnv: true, allowUnauthenticatedMcp: true, tools: [
    { name: "read_report", description: "Read the completed report", inputSchema: { type: "object", properties: {} },
      _meta: { ui: { resourceUri: "ui://proof/report" } }, appHtml: "<!doctype html><p>Completed report</p>",
      result: { content: [{ type: "text", text: "The report is saved." }], structuredContent: {
        report: "The report is saved.", launch: { toolName: "read_report", resourceUri: "ui://proof/report", arguments: {} },
      } } },
    { name: "update_note", description: "Update the client note", inputSchema: { type: "object", properties: {} },
      result: { isError: true, content: [{ type: "text", text: "MCP error -32001: Request timed out" }] } },
  ], agentWorkloads: [
    { promptMarker: SAVED_PROMPT, latestUserTurn: true, finalReply: SAVED_REPLY, steps: [] },
    { promptMarker: MCP_PROMPT, latestUserTurn: true, finalReply: MCP_REPLY, steps: [
      { tool: "execute", arguments: { code: 'const report = await tools["openwork"].read_report({}); try { await tools["openwork"].update_note({}); } catch (error) {} return report;' } },
    ] },
  ] });
  const { app, workspace } = await signedInAppWeb(seed, {
    den, webPort, env: process.env.OPENWORK_OPENCODE2_BIN ? { OPENWORK_OPENCODE2_BIN: process.env.OPENWORK_OPENCODE2_BIN } : {}, name: "offline-recovery", workspacePath: seed.tmpPath("offline-recovery"), mocks: { agent: mock },
  });
  const witness = app.mocks.agent;
  if (!witness) throw new Error("The report model witness did not start");
  await configureProvider(seed, app, workspace.workspaceId, providerId, modelId, {
    permission: { "*": "allow" },
    mcp: { "openwork": { type: "remote", url: witness.mcpUrl, enabled: true, oauth: false } },
    provider: { [providerId]: { npm: "@ai-sdk/openai-compatible", name: "Report model",
      options: { baseURL: `${witness.url}/v1`, apiKey: "sk-offline-proof" }, models: { [modelId]: { name: "Report model" } } } },
  }, engine);
  const session = await seed.session(app, { title: "Offline report recovery" });
  const registration = await addInitScript(app.client, browserScript(() => {
    const original = window.fetch.bind(window);
    const fault: OfflineFault = window.__offlineRecoveryFault = {
      disconnected: false, prompts: 0, stops: 0, probes: 0, views: 0,
      setOffline(value) {
        this.disconnected = value;
        window.dispatchEvent(new Event(value ? "offline" : "online"));
      },
    };
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => !fault.disconnected });
    window.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      if (url.pathname.endsWith("/v1/features") && init?.cache === "no-store") fault.probes++;
      const engineRequest = /\/opencode2\//.test(url.pathname);
      if (engineRequest && method === "POST" && /\/(?:prompt(?:_async)?|message|command|shell)$/.test(url.pathname)) fault.prompts++;
      if (engineRequest && method === "POST" && /\/(?:abort|interrupt)$/.test(url.pathname)) fault.stops++;
      if (url.pathname.endsWith("/mcp-apps/resolve")) {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
        if (body?.projectedToolName === "openwork_read_report") {
          fault.views++;
          return new Response(JSON.stringify({ code: "mcp_unreachable", message: "Streamable HTTP POST: connection or protocol negotiation failed" }), {
            status: 503, headers: { "Content-Type": "application/json" },
          });
        }
      }
      return original(input, init);
    };
  }, []));
  await reload(app);
  return {
    app, workspace, session, engine,
    async enable() {
      const result = await seed.api(den.admin, `/v1/admin/organizations/${organizationId}/capabilities`, {
        method: "PUT", body: JSON.stringify({ capabilities: { offlineRecovery: true } }),
      });
      if (!result.response.ok) throw new Error(`Offline recovery could not be enabled (${result.response.status})`);
      await reload(app);
    },
    // Test-owned OS connectivity hint; requests still reach the local v2 engine.
    offline: (value: boolean) => seed.evalIn(app, browserScript((value) => {
      if (!window.__offlineRecoveryFault) throw new Error("The connectivity fault is not installed");
      window.__offlineRecoveryFault.setOffline(value);
    }, [value])),
    counts: () => seed.evalIn(app, () => {
      const state = window.__offlineRecoveryFault;
      if (!state) throw new Error("The connectivity fault is not installed");
      return { prompts: state.prompts, stops: state.stops, probes: state.probes, views: state.views };
    }),
    toolCalls: () => witness.toolCalls(),
    async [Symbol.asyncDispose]() { await registration.dispose(); },
  };
}
