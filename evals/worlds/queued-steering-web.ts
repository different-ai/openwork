import { browserScript } from "@openwork/cdp";
import { engineSessionProbe, evalIn } from "@openwork/behaviors";
import { type Seed } from "@openwork/env";
import { type MockAgentWorkload } from "@openwork/labs";
import { configureProvider, steeringRecovery } from "./chat.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function records(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(records);
  const item = record(value);
  return Object.keys(item).length ? [item, ...Object.values(item).flatMap(records)] : [];
}

function userMessages(body: unknown, text: string) {
  return records(body).flatMap((item) => {
    const info = record(item.info);
    if ((info.role ?? item.type) !== "user") return [];
    const id = info.id ?? item.id;
    const texts = typeof item.text === "string" ? [item.text]
      : records(item.parts ?? item.content).flatMap((part) => part.type === "text" && typeof part.text === "string" ? [part.text] : []);
    return typeof id === "string" && texts.includes(text) ? [{ id, text }] : [];
  });
}

/** Real local engine and isolated provider witness, without Den or Electron. */
async function arrangeQueuedSteering(
  seed: Seed,
  name: string,
  agentWorkloads: MockAgentWorkload[],
  policy: Record<string, unknown> = {},
) {
  const providerId = "split-send-mock";
  const modelId = "split-send-model";
  const mock = seed.mock({ isolatedProcessEnv: true, agentWorkloads });
  const workspacePath = seed.tmpPath(name);
  const app = await seed.appWeb({ name, workspacePath, mocks: { agent: mock } });
  const agentMock = app.mocks.agent;
  if (!agentMock) throw new Error("The isolated queue model witness did not boot.");
  const workspace = await seed.workspace(app, workspacePath);
  const policyWritten = await seed.evalIn(app, browserScript(async (workspaceId, content) => {
    const port = localStorage.getItem("openwork.server.port");
    const token = localStorage.getItem("openwork.server.token");
    const response = await fetch(`http://127.0.0.1:${port}/workspace/${encodeURIComponent(workspaceId)}/files/content`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ path: "opencode.json", content }),
    });
    return response.ok;
  }, [workspace.workspaceId, JSON.stringify(policy)]), { awaitPromise: true });
  if (!policyWritten) throw new Error("Could not arrange the queue tool policy.");
  await configureProvider(seed, app, workspace.workspaceId, providerId, modelId, {
    provider: {
      [providerId]: {
        npm: "@ai-sdk/openai-compatible",
        name: "Queue steering mock",
        options: { baseURL: `${agentMock.url}/v1`, apiKey: "sk-queue-fixture-only" },
        models: { [modelId]: { name: "Queue steering model" } },
      },
    },
  });
  return { app, workspace, mock: agentMock };
}

export async function queuedSteeringWeb(seed: Seed) {
  const world = await steeringRecovery(seed, arrangeQueuedSteering);
  const endpoint = await seed.evalIn(world.app, browserScript(() => ({
    serverUrl: `http://127.0.0.1:${localStorage.getItem("openwork.server.port")}`,
    token: localStorage.getItem("openwork.server.token") ?? "",
  }), []));
  const probeOptions = { ...endpoint, workspaceId: world.workspace.workspaceId };
  const mount = `${endpoint.serverUrl}/workspace/${encodeURIComponent(world.workspace.workspaceId)}/${world.engine === "v2" ? "opencode2/api" : "opencode"}`;
  const headers = { Authorization: `Bearer ${endpoint.token}` };
  const events: unknown[] = [];
  const controller = new AbortController();
  let streamError: string | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  if (world.engine === "v2") {
    const response = await fetch(`${mount}/event`, { headers, signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`Native inbox observer failed: ${response.status}`);
    reader = response.body.getReader();
  }
  const consume = async () => {
    if (!reader) return;
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const event: unknown = JSON.parse(line.slice(5).trim());
          if (records(event).some((item) => item.type === "session.inbox.enqueued")) events.push(event);
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) streamError = String(error);
    }
  };
  const consuming = consume();
  const history = async (sessionId: string) => {
    const response = await fetch(`${mount}/session/${encodeURIComponent(sessionId)}/message?limit=100`, { headers });
    if (!response.ok) throw new Error(`Native history witness failed: ${response.status}`);
    const body: unknown = await response.json();
    return body;
  };
  return {
    ...world,
    native: engineSessionProbe({ ...probeOptions, engine: world.engine }),
    otherLane: engineSessionProbe({ ...probeOptions, engine: world.engine === "v2" ? "v1" : "v2" }),
    async nativeAdmission(sessionId: string, text: string) {
      if (world.engine === "v1") {
        return { source: "native-history", messages: userMessages(await history(sessionId), text), streamError };
      }
      const messages = events.flatMap((event) => records(event).flatMap((item) => {
        if (item.type !== "session.inbox.enqueued") return [];
        const data = record(item.data ?? item.properties);
        const inbox = record(data.item);
        const payload = record(inbox.payload);
        return data.sessionID === sessionId && inbox.type === "user" && payload.text === text && typeof data.inboxID === "string"
          ? [{ id: data.inboxID, text }] : [];
      }));
      return { source: "native-inbox-event", messages, streamError };
    },
    async nativeCompletion(sessionId: string, text: string, callId: string) {
      const body = await history(sessionId);
      const tool = records(body).find((item) => (item.callID ?? item.id) === callId && record(item.state).status === "completed");
      const completedAt = world.engine === "v1" ? record(record(tool?.state).time).end : record(tool?.time).completed;
      return { messages: userMessages(body, text), completedAt: typeof completedAt === "number" ? completedAt : null, body };
    },
    async [Symbol.asyncDispose]() {
      controller.abort();
      await reader?.cancel().catch(() => undefined);
      await consuming;
    },
    runtimeStatus: () => evalIn(world.app, browserScript(async () => {
      const port = localStorage.getItem("openwork.server.port");
      const token = localStorage.getItem("openwork.server.token");
      const response = await fetch(`http://127.0.0.1:${port}/experimental/engine-v2-preview/status`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body: unknown = await response.json();
      return { status: response.status, body, electronBridge: Boolean(window.__OPENWORK_ELECTRON__) };
    }, [])),
  };
}
