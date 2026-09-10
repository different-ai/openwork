import { mkdir, realpath } from "node:fs/promises";
import { resolveEvalEngine, type Seed } from "@openwork/env";
import { browserScript } from "@openwork/cdp";
import { configureProvider } from "./chat.ts";

export async function taskActivityWeb(seed: Seed) {
  const path = seed.tmpPath("task-activity-web");
  await mkdir(path, { recursive: true });
  const workspacePath = await realpath(path);
  const engine = resolveEvalEngine();
  const providerId = "activity-mock";
  const modelId = "activity-model";
  const marker = "ACTIVITY_CHILD_HOLD";
  const prompt = "Delegate building the isolated reproduction, then report the result.";
  const app = await seed.appWeb({ name: "task-activity-web", workspacePath, mocks: {
    agent: seed.mock({ isolatedProcessEnv: true, agentWorkloads: [{
      promptMarker: prompt, latestUserTurn: true, finalReply: "Delegation finished.",
      steps: [{ tool: engine === "v2" ? "subagent" : "task", arguments: {
        description: "Build isolated Azure repro", prompt: marker,
        ...(engine === "v2" ? { agent: "general", background: false } : { subagent_type: "general" }),
      } }],
    }, {
      promptMarker: marker, latestUserTurn: true, steps: [],
      finalReply: "Activity child started. Activity child finished.",
      finalReplyChunks: ["Activity child started. ", "Activity child finished."],
      finalReplyInitiallyReleasedChunks: 1,
    }] }),
  } });
  const workspace = await seed.workspace(app, workspacePath);
  const mock = app.mocks.agent;
  if (!mock) throw new Error("Missing activity model witness");
  await configureProvider(seed, app, workspace.workspaceId, providerId, modelId, {
    permission: { task: "allow" },
    provider: { [providerId]: { npm: "@ai-sdk/openai-compatible", name: "Activity mock",
      options: { baseURL: `${mock.url}/v1`, apiKey: "sk-activity-fixture" },
      models: { [modelId]: { name: "Activity model" } },
    } },
  }, engine);
  const session = await seed.session(app, { title: "Delegated activity" });
  const native = () => seed.evalIn(app, browserScript(async (workspaceId, sessionId, engine) => {
    const base = "http://127.0.0.1:" + localStorage.getItem("openwork.server.port")
      + "/workspace/" + encodeURIComponent(workspaceId) + (engine === "v2" ? "/opencode2/api" : "/opencode");
    const response = await fetch(base + "/session/" + encodeURIComponent(sessionId) + "/message?limit=50", {
      headers: { Authorization: "Bearer " + localStorage.getItem("openwork.server.token") },
    });
    if (!response.ok) throw new Error("Native history: " + response.status);
    const raw: unknown = await response.json();
    const data = raw && typeof raw === "object" && "data" in raw ? raw.data : raw;
    for (const message of Array.isArray(data) ? data : []) {
      for (const part of message.parts ?? message.content ?? []) {
        if ((part.tool ?? part.name) !== (engine === "v2" ? "subagent" : "task")) continue;
        const metadata = part.state?.metadata;
        let childId = metadata?.sessionId ?? metadata?.sessionID;
        if (!childId) {
          const childrenResponse = await fetch(base + "/session?limit=100", {
            headers: { Authorization: "Bearer " + localStorage.getItem("openwork.server.token") },
          });
          const children = await childrenResponse.json();
          const matches = (Array.isArray(children) ? children : children.data ?? [])
            .filter((child: { parentID?: string }) => child.parentID === sessionId);
          if (matches.length === 1) childId = matches[0].id;
        }
        const childHistory = part.state?.status === "error" && childId
          ? await (await fetch(base + "/session/" + encodeURIComponent(childId) + "/message?limit=20", {
            headers: { Authorization: "Bearer " + localStorage.getItem("openwork.server.token") },
          })).text() : undefined;
        return { messageId: message.info?.id ?? message.id, callId: part.callID ?? part.id,
          childId, status: part.state?.status, error: part.state?.error, metadata, childHistory };
      }
    }
    return null;
  }, [workspace.workspaceId, session.sessionId, engine]), { awaitPromise: true });
  return { app, workspace, session, prompt, native, replyState: () => mock.agentReplyState(marker) };
}
