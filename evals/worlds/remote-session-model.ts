import { randomUUID } from "node:crypto";
import { browserScript, reload } from "@openwork/cdp";
import type { Seed } from "@openwork/env";
import { configureProvider } from "./chat.ts";
import { denForAppWeb, signedInAppWeb } from "./signed-in-app-web.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Native API arrangement simulates a conversation launched by a remote client.
 * No renderer session.create (which remembers a local selection), session store,
 * session read, catalog or health response is mocked. Only inference is synthetic. */
export async function remoteSessionModel(seed: Seed) {
  const { den, webPort } = await denForAppWeb(seed);
  const providerID = "remote-model-proof";
  const launched = { providerID, modelID: "remote-reasoning", name: "Remote reasoning", variant: "high" };
  const alternate = { providerID, modelID: "workspace-default", name: "Workspace default" };
  const prompt = "Check the remote conversation launch checklist.";
  const reply = "The remote conversation checklist is ready.";
  const token = randomUUID();
  const hostToken = randomUUID();
  const { app, workspace } = await signedInAppWeb(seed, {
    den, webPort, engine: "v2", headless: true, name: "remote-session-model",
    workspacePath: seed.tmpPath("remote-session-model"),
    env: { OPENWORK_TOKEN: token, OPENWORK_HOST_TOKEN: hostToken },
    mocks: { agent: seed.mock({ isolatedProcessEnv: true, agentWorkloads: [{
      promptMarker: prompt, latestUserTurn: true, finalReply: reply, steps: [],
    }] }) },
  });
  const witness = app.mocks.agent;
  if (!witness) throw new Error("The synthetic inference endpoint did not start");
  await configureProvider(seed, app, workspace.workspaceId, providerID, alternate.modelID, {
    model: `${providerID}/${alternate.modelID}`,
    small_model: `${providerID}/${alternate.modelID}`,
    provider: { [providerID]: {
      npm: "@ai-sdk/openai-compatible", name: "Conversation models",
      options: { baseURL: `${witness.url}/v1`, apiKey: "synthetic-remote-model-key" },
      models: {
        [launched.modelID]: { name: launched.name, reasoning: true, tool_call: true,
          variants: { high: { reasoningEffort: "high" }, low: { reasoningEffort: "low" } } },
        [alternate.modelID]: { name: alternate.name, tool_call: true },
      },
    } },
  }, "v2");
  const mount = `/workspace/${encodeURIComponent(workspace.workspaceId)}/opencode2/api/session`;
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(`${app.openworkUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${token}`, "x-openwork-host-token": hostToken, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    });
    const result: unknown = await response.json();
    if (!response.ok) throw new Error(`Native session API failed: ${response.status} ${JSON.stringify(result)}`);
    return isRecord(result) && "data" in result ? result.data : result;
  };
  const title = "Remote launch planning";
  const created = await request(mount, { title, model: { providerID, id: launched.modelID, variant: launched.variant } });
  if (!isRecord(created) || typeof created.id !== "string") throw new Error("Native session creation returned no session ID");
  const sessionId = created.id;
  const nativeAtLaunch = await request(`${mount}/${encodeURIComponent(sessionId)}`);
  if (!isRecord(nativeAtLaunch) || !isRecord(nativeAtLaunch.model)
    || nativeAtLaunch.model.providerID !== providerID || nativeAtLaunch.model.id !== launched.modelID
    || nativeAtLaunch.model.variant !== launched.variant) {
    throw new Error(`The real native session did not retain its launch model: ${JSON.stringify(nativeAtLaunch)}`);
  }
  // Read-only fixture witness: creating remotely must not have written local
  // per-session memory. Evaluation stays in world arrangement, not user acts.
  const localAtLaunch = await seed.evalIn(app, browserScript((sessionId) => {
    const raw = localStorage.getItem("openwork.sessionModels.v1");
    const parsed = raw ? JSON.parse(raw) : {};
    return { remembered: Object.hasOwn(parsed, sessionId), defaultModel: localStorage.getItem("openwork.defaultModel") };
  }, [sessionId]));
  await reload(app);
  return {
    app, workspace, sessionId, title, launched, alternate, prompt, reply, nativeAtLaunch, localAtLaunch,
    nativeSession: () => request(`${mount}/${encodeURIComponent(sessionId)}`),
    requests: () => witness.agentRequests({ promptMarker: prompt }),
  };
}
