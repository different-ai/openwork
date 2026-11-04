import { randomUUID } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { engineSessionProbe } from "@openwork/behaviors";
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
  await using setup = new AsyncDisposableStack();
  const mock = (await seed.mock({ isolatedProcessEnv: true }).boot(place)).handle;
  setup.defer(() => mock.stop());
  const providerId = "opencode";
  const originalModelId = "big-pickle";
  const replacementModelId = "session-management-alternate";
  const configuration = {
    permission: { "*": "allow" },
    enabled_providers: [providerId],
    model: `${providerId}/${originalModelId}`,
    small_model: `${providerId}/${originalModelId}`,
    provider: { [providerId]: {
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: `${mock.url}/v1`, apiKey: "session-management-synthetic-key" },
      whitelist: [originalModelId, replacementModelId],
      models: Object.fromEntries([
        [originalModelId, "Management caller"], [replacementModelId, "Management alternate"],
      ].map(([id, name]) => [id, {
        name, tool_call: true, limit: { context: 128000, output: 8192 },
        provider: { npm: "@ai-sdk/openai-compatible", api: `${mock.url}/v1` },
      }])),
    } },
  };
  const temporaryPath = seed.tmpPath("v2-session-management");
  await mkdir(temporaryPath, { recursive: true });
  const workspacePath = await realpath(temporaryPath);
  // Configure both default and utility models before startup: no real provider
  // is needed, even for an automatic title or compaction request.
  await writeFile(join(workspacePath, "opencode.json"), JSON.stringify(configuration));
  const token = randomUUID();
  const app = await seed.appWeb({
    name: "v2-session-management", workspacePath, engine: "v2", headless: true, mouse: true,
    env: {
      OPENWORK_TOKEN: token,
      ...(process.env.OPENWORK_OPENCODE_BIN ? { OPENWORK_OPENCODE_BIN: process.env.OPENWORK_OPENCODE_BIN } : {}),
      ...(process.env.OPENWORK_OPENCODE2_BIN ? { OPENWORK_OPENCODE2_BIN: process.env.OPENWORK_OPENCODE2_BIN } : {}),
    },
  });
  async function read(path: string): Promise<unknown> {
    const response = await fetch(`${app.openworkUrl}${path}`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Session management read failed: ${response.status} ${path}`);
    return response.json();
  }
  // Native installation can take longer than the session control rail deadline.
  const engine = await eventually(async () => {
    const value = await read("/experimental/engine-v2-preview/status");
    return {
      running: isRecord(value) && value.running === true,
      version: isRecord(value) && typeof value.version === "string" ? value.version : "",
    };
  }, { within: 210_000, intervalMs: 1_000, label: "the native v2 engine is running", until: value => value.running && Boolean(value.version) });
  const workspace = await seed.workspace(app, workspacePath);
  await configureProvider(seed, app, workspace.workspaceId, providerId, originalModelId, configuration, "v2");
  const target = await seed.session(app, { title: "Planning notes" });
  const caller = await seed.session(app, { title: "Organize my conversations" });
  const mount = `/workspace/${encodeURIComponent(workspace.workspaceId)}/opencode2/api/session`;
  // Bind an idle target without inference as fixture arrangement, not as the
  // operation under test. Every subsequent mutation comes from native tools.
  const bound = await fetch(`${app.openworkUrl}${mount}/${encodeURIComponent(target.sessionId)}/model`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({ model: { providerID: providerId, id: originalModelId } }),
  });
  if (!bound.ok) throw new Error(`Could not arrange the target model: ${bound.status} ${await bound.text()}`);
  const native = engineSessionProbe({ engine: "v2", serverUrl: app.openworkUrl, token, workspaceId: workspace.workspaceId });
  const resources = setup.move();
  return {
    app, workspace, caller, target, engine,
    providerId, originalModelId, replacementModelId, renamedTitle: "Planning notes — ready",
    async prepareTurn(promptMarker: string, finalReply: string, steps: MockAgentToolStep[]) {
      const response = await fetch(`${mock.url}/admin/agent-workloads`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workloads: [{ promptMarker, latestUserTurn: true, finalReply, steps }] }),
      });
      if (!response.ok) throw new Error("Could not configure the session management model witness");
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
        throw new Error(`Invalid native session readback: ${JSON.stringify(raw)}`);
      }
      if (!messages.ok) throw new Error(`Could not read native session messages: ${messages.status}`);
      const model = isRecord(session.model) ? session.model : {};
      return {
        id: session.id, title: session.title,
        archived: typeof session.time.archived === "number" && session.time.archived > 0,
        model: { providerId: model.providerID, modelId: model.id },
        messageCount: messages.data.length,
      };
    },
    [Symbol.asyncDispose]: () => resources[Symbol.asyncDispose](),
  };
}
