import { resolveEvalEngine, type Seed } from "@openwork/env";
import { browserScript } from "@openwork/cdp";
import { evalIn } from "@openwork/behaviors";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/** The existing overlapping long-tool/queued-turn workloads on a real app-web stack. */
export async function queuedSessionSwitchWeb(seed: Seed) {
  const engine = resolveEvalEngine();
  const tool = engine === "v2" ? "shell" : "bash";
  const runId = `${Date.now().toString(36)}-${process.pid}`;
  const promptMarker = `LIVE-TOOL-SWITCH-${runId}`;
  const firstMarker = `FIRST-${promptMarker}`;
  const firstToolDescription = `First tool in chat A — ${promptMarker}`;
  const toolDescription = `Waiting in chat A — ${promptMarker}`;
  const completionMarker = `DONE-${promptMarker}`;
  const replyA = `REPLY-A-${runId}`;
  const promptB = `SECOND-CHAT-${runId}`;
  const replyB = `REPLY-B-${runId}`;
  const progressA = `PROGRESS-A-${runId}`;
  const continuedProgressA = `CONTINUED-A-${runId}`;
  const progressB = `PROGRESS-B-${runId}`;
  const queuedA = [`FOLLOW-UP-A1-${runId}`, `FOLLOW-UP-A2-${runId}`];
  const queuedB = `FOLLOW-UP-B-${runId}`;
  const queuedRepliesA = [`ANSWER-A1-${runId}`, `ANSWER-A2-${runId}`];
  const queuedReplyB = `ANSWER-B-${runId}`;
  const commandB = `sleep 180 && printf '%s\\n' 'TOOL-B-${runId}'`;
  const firstCommand = `sleep 45 && printf '%s\\n' '${firstMarker}'`;
  const command = `sleep 45 && printf '%s\\n' '${completionMarker}'`;
  const continuedCommand = `sleep 30 && printf '%s\\n' 'LAST-TOOL-A-${runId}'`;
  const args = (command: string, description: string, timeout = 90_000) => ({
    command, timeout, ...(engine === "v1" ? { description } : {}),
  });
  const mock = seed.mock({ isolatedProcessEnv: true, agentWorkloads: [
    {
      promptMarker, latestUserTurn: true, finalReply: replyA, finalReplyChunkSize: 4,
      steps: [
        { tool, arguments: args(firstCommand, firstToolDescription) },
        { tool, text: progressA, arguments: args(command, toolDescription) },
        { tool, text: continuedProgressA, arguments: args(continuedCommand, "Chat A continues after returning") },
      ],
    },
    { promptMarker: promptB, latestUserTurn: true, finalReply: replyB, finalReplyChunkSize: 4,
      steps: [{ tool, text: progressB, arguments: args(commandB, "Long-running tool in chat B", 240_000) }] },
    ...queuedA.map((promptMarker, index) => ({ promptMarker, latestUserTurn: true,
      finalReply: queuedRepliesA[index], finalReplyDelayMs: 1000, steps: [] })),
    { promptMarker: queuedB, latestUserTurn: true, finalReply: queuedReplyB, steps: [] },
  ] });
  const app = await seed.appWeb({ name: "queued-session-switch", workspacePath: seed.tmpPath("queue-switch-a"), mocks: { agent: mock } });
  const agentMock = app.mocks.agent;
  if (!agentMock) throw new Error("The queued session-switch provider witness did not boot.");
  const workspaceA = await seed.workspace(app);
  const workspaceB = await seed.workspace(app, seed.tmpPath("queue-switch-b"), { create: true });
  // Provision the deterministic provider through the owned engine-global API,
  // rather than relying on a primary workspace's directory-local configuration.
  await app.configureProviders({ "live-tool-switch-mock": {
      npm: "@ai-sdk/openai-compatible", name: "Live tool switch model",
      options: { baseURL: `${agentMock.url}/v1`, apiKey: "sk-live-tool-switch" },
      models: { "live-tool-switch-model": { name: "Live tool switch model", tool_call: true } },
    } });
  const providerState = (workspaceId: string) => evalIn(app, browserScript(async (workspaceId, engine) => {
    const port = localStorage.getItem("openwork.server.port");
    const token = localStorage.getItem("openwork.server.token");
    const paths = [`/workspace/${workspaceId}/config`, `/workspace/${workspaceId}/${engine === "v2" ? "opencode2/api/model" : "opencode/provider"}`,
      ...(engine === "v1" ? [`/workspace/${workspaceId}/opencode/config`, `/workspace/${workspaceId}/opencode/path`] : [])];
    return Promise.all(paths.map(async (path) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { Authorization: `Bearer ${token}` } });
      const body: unknown = await response.json();
      if (path.endsWith("/provider") && typeof body === "object" && body !== null && "all" in body && Array.isArray(body.all)) {
        return { path, status: response.status, body: {
          providers: body.all.map((provider: unknown) => {
            if (typeof provider !== "object" || provider === null || !("id" in provider)) return null;
            const models = "models" in provider && typeof provider.models === "object" && provider.models !== null ? Object.keys(provider.models) : [];
            return { id: provider.id, modelCount: models.length, fixtureModel: models.includes("live-tool-switch-model") };
          }),
          connected: "connected" in body ? body.connected : null,
        } };
      }
      return { path, status: response.status, body };
    }));
  }, [workspaceId, engine]));
  return { app, agentMock, workspaceA, workspaceB, providerState,
    devLog: () => readFile(resolve(import.meta.dirname, "../../tmp/worlds/runtime", app.handle.name, "web.log"), "utf8")
      .catch(() => "Local development log unavailable; see the fixture's placement receipt."),
    runId, promptMarker, firstMarker, firstToolDescription, toolDescription,
    completionMarker, replyA, promptB, replyB, progressA, continuedProgressA, progressB,
    queuedA, queuedB, queuedRepliesA, queuedReplyB, commandB, firstCommand, command, continuedCommand };
}
