import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as wait } from "node:timers/promises";
import { evaluate } from "@openwork/cdp";
import { z } from "zod";
import { eventually, type Seed } from "@openwork/env";
import { mcpAppResourceUri } from "@openwork/types/mcp-app";
import { buildGeneratedMcpApp } from "../../ee/apps/den-api/src/generated-artifact-view-builder.ts";
import { configureProvider } from "./chat.ts";
import { appPresentationHttp } from "./app-presentation-http.ts";

export const APP_REQUEST = "Make a project checklist I can open later.";
export const APP_REPLY = "The project checklist is published. Open it to review and mark completed items.";
export const APP_FALLBACK = "Review the project checklist and mark completed items.";
const appId = "cob_00000000000000000000000000";
const revisionId = "cov_00000000000000000000000000";
export const APP_RESOURCE = mcpAppResourceUri(appId, revisionId);
type Scenario = "cold" | "warm" | "slow" | "error" | "reopen" | "bootstrap" | "denied" | "auth-outage";

/** Real appWeb, engine, message capture and generated React runtime. Resource
 * discovery and one declared read use deterministic HTTP fixtures, never live
 * providers. The useful view appears only after the read crosses the real bridge. */
export async function appPresentation(seed: Seed) {
  const healthy = await buildGeneratedMcpApp({ title: "Project checklist", description: null,
    reactSource: `export default function Checklist({ app, result }) {
      const [done, setDone] = React.useState(false);
      const [status, setStatus] = React.useState(null);
      const [freshness, setFreshness] = React.useState(null);
      React.useEffect(() => {
        if (result === undefined) return;
        let closed = false;
        app.callServerTool({ name: "read_checklist", arguments: {} }).then(reply => {
          if (!closed && !reply.isError) {
            setStatus(reply.structuredContent.status);
            setFreshness(reply._meta?.["openwork/cachedAt"] ? "Saved result" : "Read result");
          }
        });
        return () => { closed = true; };
      }, [app, result]);
      return <main>{status === null ? <p role="status">Checking project items</p> : <><h2>Project checklist</h2><p>{done ? "Review completed" : status}</p><p>{freshness}</p><button type="button" onClick={() => setDone(true)}>Mark reviewed</button></>}</main>;
    }`, cssSource: "body{margin:0}main{padding:16px}h2{font-size:16px}button{font:inherit}" });
  const broken = await buildGeneratedMcpApp({ title: "Project checklist", description: null,
    reactSource: `export default function Checklist() { throw new Error("The checklist could not render."); }` });
  const bootstrap = await buildGeneratedMcpApp({ title: "Project checklist", description: null,
    reactSource: `export default function Checklist({ result }) {
      const [reviewed, setReviewed] = React.useState(false);
      const title = result.structuredContent.app.title;
      return <main><h2>{reviewed ? "Checklist reviewed" : title}</h2><p>Launch data received</p><button type="button" onClick={() => setReviewed(true)}>Mark reviewed</button></main>;
    }` });
  if (!healthy.ok || !broken.ok || !bootstrap.ok) throw new Error("The representative generated App did not compile");
  const summary = { appId, revisionId, resourceUri: APP_RESOURCE, title: "Project checklist", description: null,
    pluginId: "plg_00000000000000000000000000", toolName: "open_app", serverPath: `/mcp/agent/connections/${appId}`,
    textFallback: APP_FALLBACK, tools: [{ name: "read_checklist", description: "Read the project checklist", capability: "fixture:read-checklist", mode: "input", readOnly: true }] };
  const launch = { connectionId: appId, toolName: "open_app", resourceUri: APP_RESOURCE, arguments: {} };
  const mock = seed.mock({ isolatedProcessEnv: true, allowUnauthenticatedMcp: true,
    tools: [{ name: "create_app", description: "Publish the requested project checklist", inputSchema: { type: "object", properties: {} },
      result: { content: [{ type: "text", text: "The project checklist is published." }],
        structuredContent: { app: summary, launch, input: {} }, _meta: { "openwork/mcpApp": launch } } }],
    agentWorkloads: [{ promptMarker: APP_REQUEST, latestUserTurn: true, finalReply: APP_REPLY,
      finalReplyChunks: [APP_REPLY], finalReplyInitiallyReleasedChunks: 0,
      steps: [{ tool: "create_app", arguments: {} }] }],
  });
  const app = await seed.appWeb({ name: "app-presentation", workspacePath: seed.tmpPath("app-presentation"), engine: "v1", headless: true,
    // No organization is needed for this local presentation proof. Keep even
    // anonymous deployment-feature discovery away from the production Den.
    // Reuse installed dependencies; never let pnpm repair metadata by installing.
    env: { OPENWORK_DEV_DEN_PROXY_TARGET: "http://127.0.0.1:9", pnpm_config_verify_deps_before_run: "warn" }, mocks: { agent: mock } });
  const witness = app.mocks.agent;
  if (!witness) throw new Error("The publication witness did not start");
  const workspace = await seed.workspace(app, app.workspaceRoot);
  await configureProvider(seed, app, workspace.workspaceId, "presentation", "checklist", {
    permission: { "*": "allow" },
    mcp: { openwork: { type: "remote", url: witness.mcpUrl, enabled: true, oauth: false } },
    provider: { presentation: { npm: "@ai-sdk/openai-compatible", name: "Project model",
      options: { baseURL: `${witness.url}/v1`, apiKey: "synthetic-presentation-key" }, models: { checklist: { name: "Project model" } } } },
  }, "v1");
  const neighbor = await seed.session(app, { title: "Reference notes" });
  const session = await seed.session(app, { title: "Project checklist" });
  let scenario: Scenario = "cold";
  const resolutions: { scenario: Scenario; elapsedMs: number }[] = [];
  const providerReads: { scenario: Scenario; elapsedMs: number }[] = [];
  const keptResultChecks: { scenario: Scenario }[] = [];
  let count = 0;
  const network = await appPresentationHttp(app, async () => {
    const current = scenario;
    const start = performance.now();
    if (current === "slow") await wait(1_800);
    else if (current === "cold") await wait(250);
    resolutions.push({ scenario: current, elapsedMs: Math.round(performance.now() - start) });
    if (current === "denied") return { code: "mcp_access_denied", message: "App access was removed. Ask an administrator to review access." };
    if (current === "auth-outage") return { code: "mcp_auth_required", message: "The connection needs a fresh sign-in." };
    return { app: { launchId: `presentation-${++count}`, serverName: "openwork-app-host-connect-fixture", toolName: "open_app",
      resourceUri: APP_RESOURCE, html: current === "error" ? broken.html : current === "bootstrap" ? bootstrap.html : healthy.html, csp: healthy.csp, prefersBorder: false } };
  }, async checkOnly => {
    const current = scenario;
    if (checkOnly) {
      keptResultChecks.push({ scenario: current });
      return { content: [], _meta: { "openwork/readOnly": true, "openwork/providerIdentity": "synthetic-checklist-provider" } };
    }
    const start = performance.now();
    await wait(120);
    providerReads.push({ scenario: current, elapsedMs: Math.round(performance.now() - start) });
    return { content: [{ type: "text", text: "Review pending" }], structuredContent: { status: "Review pending" },
      _meta: { "openwork/readOnly": true, "openwork/providerIdentity": "synthetic-checklist-provider" } };
  }, () => scenario === "bootstrap");
  if (!app.client.webSocketDebuggerUrl) throw new Error("The App's browser has no CDP endpoint");
  const endpoint = new URL(app.client.webSocketDebuggerUrl);
  const flicker = fileURLToPath(new URL("../../.opencode/skills/measure-chat-flicker/scripts/flicker.mjs", import.meta.url));
  const runFlicker = (command: "arm" | "report") => execFileSync(process.execPath, [flicker, command], {
    env: { ...process.env, CDP_URL: `http://${endpoint.host}` }, encoding: "utf8", timeout: 20_000,
  }).trim();
  return {
    app, session, neighbor, workspace,
    scenario(next: Scenario) { network.check(); scenario = next; },
    resolutions() { network.check(); return [...resolutions]; },
    providerReads() { network.check(); return [...providerReads]; },
    keptResultChecks() { network.check(); return [...keptResultChecks]; },
    bootstrapDelayedDocuments: () => network.bootstrapDelayedDocuments(),
    // Browser network controls, never renderer stores: cold means a fresh
    // renderer document plus cleared/disabled HTTP cache, not a cold process.
    async coldBrowserCache() {
      await app.client.send("Network.enable");
      await app.client.send("Network.clearBrowserCache");
      await app.client.send("Network.setCacheDisabled", { cacheDisabled: true });
    },
    async warmBrowserCache() { await app.client.send("Network.setCacheDisabled", { cacheDisabled: false }); },
    published: () => witness.toolCalls(),
    releaseReply: async () => {
      // Open may appear before the engine requests the next model round. Observe
      // the actual held reply before issuing one release; never race a 404 write.
      await eventually(() => witness.agentReplyState(APP_REQUEST), {
        within: 15_000, intervalMs: 100, label: "the model's held final reply",
        until: state => state.waiting > 0 && !state.complete,
      });
      return witness.releaseAgentReply(APP_REQUEST, 1);
    },
    armFlicker: () => runFlicker("arm"),
    flicker: () => z.object({ upwardJumps: z.number(), downwardMoves: z.number(), samples: z.string() }).parse(JSON.parse(runFlicker("report"))),
    // Read-only observations: actual layout, focus and bounded diagnostic timing.
    geometry: () => evaluate(app.client, () => {
      const rect = (selector: string) => {
        const element = document.querySelector(selector);
        if (!element) return null;
        const r = element.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
      };
      return { fallback: rect("[data-mcp-app-fallback]"), panel: rect("[data-built-app-preview]"),
        composer: rect('[data-lexical-editor="true"]'), loading: rect("[data-loading-message]"),
        focus: document.activeElement?.getAttribute("aria-label"),
        timings: performance.getEntriesByType("measure").filter(entry => entry.name.startsWith("openwork.mcp-app.")).map(entry => ({ name: entry.name, duration: Math.round(entry.duration) })) };
    }),
    async [Symbol.asyncDispose]() { await network[Symbol.asyncDispose](); },
  };
}
