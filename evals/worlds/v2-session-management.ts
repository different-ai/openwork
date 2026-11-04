import { randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { browserScript } from "@openwork/cdp";
import { engineSessionProbe, evalIn } from "@openwork/behaviors";
import { eventually, type Place, type Seed } from "@openwork/env";
import type { MockAgentToolStep } from "@openwork/labs";
import { configureProvider } from "./chat.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dataOf(value: unknown): unknown {
  return isRecord(value) && "data" in value ? value.data : value;
}

/** Real server, renderer and native v2 tools; only model HTTP responses are scripted. */
export async function v2SessionManagement(seed: Seed, { place }: { place: Place }) {
  const providerId = "opencode";
  const originalModelId = "big-pickle";
  const replacementModelId = "session-management-alternate";
  const temporaryPath = seed.tmpPath("v2-session-management");
  // A Mac realpath starts /private/tmp, which is neither present nor writable
  // on the sandbox. The app-web fixture creates its own remote workspace.
  let workspacePath = temporaryPath;
  if (place.kind !== "daytona") {
    await mkdir(temporaryPath, { recursive: true });
    workspacePath = await realpath(temporaryPath);
  }
  const token = randomUUID();
  const app = await seed.appWeb({
    name: "v2-session-management", workspacePath, engine: "v2", headless: true, mouse: true,
    mocks: { agent: seed.mock({ isolatedProcessEnv: true }) },
    env: { OPENWORK_TOKEN: token },
  });
  const mock = app.mocks.agent;
  if (!mock) throw new Error("The app-web fixture did not start its model witness");
  // Reads execute on the browser's computer, not the runner's loopback. This
  // witnesses actual native state on both local and co-located Daytona runs.
  async function request(base: string, path: string, method = "GET", body: unknown = null): Promise<unknown> {
    const result = await evalIn(app, browserScript(async (base, path, token, method, body) => {
      const response = await fetch(base + path, {
        method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        ...(body === null ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
      });
      return { status: response.status, body: await response.json() };
    }, [base, path, token, method, body]), { awaitPromise: true, timeoutMs: 35_000 });
    if (!isRecord(result) || typeof result.status !== "number" || result.status < 200 || result.status >= 300) {
      throw new Error(`Session management request failed: ${path} (HTTP ${isRecord(result) ? result.status : "unknown"})`);
    }
    return result.body;
  }
  const read = (path: string) => request(app.openworkUrl, path);
  const engine = await eventually(async () => {
    const value = await read("/experimental/engine-v2-preview/status");
    return {
      running: isRecord(value) && value.running === true,
      version: isRecord(value) && typeof value.version === "string" ? value.version : "",
    };
  }, { within: 210_000, intervalMs: 1_000, label: "the native v2 engine is running", until: value => value.running && Boolean(value.version) });
  const workspace = await seed.workspace(app, workspacePath);
  const configuration = {
    permission: { "*": "allow" }, enabled_providers: [providerId],
    model: `${providerId}/${originalModelId}`, small_model: `${providerId}/${originalModelId}`,
    provider: { [providerId]: {
      npm: "@ai-sdk/openai-compatible", options: { baseURL: `${mock.url}/v1`, apiKey: "session-management-synthetic-key" },
      whitelist: [originalModelId, replacementModelId],
      models: Object.fromEntries([
        [originalModelId, "Management caller"], [replacementModelId, "Management alternate"],
      ].map(([id, name]) => [id, {
        name, tool_call: true, limit: { context: 128000, output: 8192 },
        provider: { npm: "@ai-sdk/openai-compatible", api: `${mock.url}/v1` },
      }])),
    } },
  };
  await configureProvider(seed, app, workspace.workspaceId, providerId, originalModelId, configuration, "v2");
  const target = await seed.session(app, { title: "Planning notes" });
  const caller = await seed.session(app, { title: "Organize my conversations" });
  const mount = `/workspace/${encodeURIComponent(workspace.workspaceId)}/opencode2/api/session`;
  // Arrange an idle target without inference. The operations under test below
  // all come from native agent tools, never direct renderer control commands.
  await request(app.openworkUrl, `${mount}/${encodeURIComponent(target.sessionId)}/model`, "POST", {
    model: { providerID: providerId, id: originalModelId },
  });
  const native = engineSessionProbe({ engine: "v2", surface: app, workspaceId: workspace.workspaceId });
  return {
    app, workspace, caller, target, engine,
    providerId, originalModelId, replacementModelId, renamedTitle: "Planning notes — ready",
    async prepareTurn(promptMarker: string, finalReply: string, steps: MockAgentToolStep[]) {
      await request(mock.url, "/admin/agent-workloads", "POST", {
        workloads: [{ promptMarker, latestUserTurn: true, finalReply, steps }],
      });
    },
    async modelCalls(promptMarker: string) {
      return mock.agentRequests({ promptMarker, atLeast: 1, timeoutMs: 30_000 });
    },
    async calls() {
      const messages = await native.messages(caller.sessionId, 200);
      if (!messages.ok) throw new Error(`Could not read native caller messages: ${messages.status}`);
      return messages.data.flatMap(message => message.parts).filter(part => part.tool !== "");
    },
    async inspect(sessionId = target.sessionId) {
      const [raw, messages] = await Promise.all([
        read(`${mount}/${encodeURIComponent(sessionId)}`), native.messages(sessionId, 200),
      ]);
      const session = dataOf(raw);
      if (!isRecord(session) || typeof session.id !== "string" || typeof session.title !== "string" || !isRecord(session.time)) {
        throw new Error("Invalid native session readback");
      }
      if (!messages.ok) throw new Error(`Could not read native session messages: ${messages.status}`);
      const model = isRecord(session.model) ? session.model : {};
      const data = dataOf(messages.body);
      const items = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data.items) ? data.items : null;
      if (!items) throw new Error("Invalid native message listing");
      return {
        id: session.id, title: session.title,
        archived: typeof session.time.archived === "number" && session.time.archived > 0,
        model: { providerId: model.providerID, modelId: model.id },
        // Model changes can append bookkeeping markers without a prompt or
        // inference. Count user/assistant messages, not model-switched markers.
        messageCount: items.filter(item => isRecord(item) && (item.type === "user" || item.type === "assistant")).length,
      };
    },
  };
}
