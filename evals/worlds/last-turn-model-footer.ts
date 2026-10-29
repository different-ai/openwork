import { randomUUID } from "node:crypto";
import type { Seed } from "@openwork/env";
import { denForAppWeb, signedInAppWeb } from "./signed-in-app-web.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Persist real completed model turns through the engine API, never renderer state. */
export async function lastTurnModelFooter(seed: Seed) {
  const providerId = "openai";
  const modelId = "gpt-footer";
  const modelName = "GPT-6 Luna";
  let repliesWithoutResolvedMetadata = 0;
  const older = { prompt: "Check five report sections and summarize the result.", reply: "All five report sections are ready." };
  const latest = { prompt: "Give me the final report status.", reply: "The report is ready to share." };
  const mock = seed.mock({ agentWorkloads: [
    { promptMarker: older.prompt, latestUserTurn: true, finalReply: older.reply,
      steps: Array.from({ length: 5 }, (_, index) => ({ tool: "shell", arguments: {
        command: `printf 'Section ${index + 1} checked\\n'`, description: `Check report section ${index + 1}`,
      } })) },
    { promptMarker: latest.prompt, latestUserTurn: true, finalReply: latest.reply, steps: [] },
  ] });
  const { den, webPort } = await denForAppWeb(seed, { mocks: { agent: mock } });
  const token = randomUUID();
  const hostToken = randomUUID();
  const { app, workspace } = await signedInAppWeb(seed, {
    name: "last-turn-model-footer", den, webPort, headless: true,
    workspacePath: seed.tmpPath("last-turn-model-footer"), engine: "v2",
    env: { OPENWORK_TOKEN: token, OPENWORK_HOST_TOKEN: hostToken },
  });
  const mount = `/workspace/${workspace.workspaceId}`;
  async function request(path: string, init: RequestInit = {}) {
    return fetch(`${app.openworkUrl}${path}`, {
      ...init, signal: AbortSignal.timeout(120_000),
      headers: { Authorization: `Bearer ${token}`, "x-openwork-host-token": hostToken, "Content-Type": "application/json" },
    });
  }
  const configured = await request(`${mount}/config`, { method: "PATCH", body: JSON.stringify({ opencode: {
    permission: { bash: "allow" },
    provider: { [providerId]: {
      npm: "@ai-sdk/openai-compatible", name: "OpenAI",
      options: { baseURL: `${den.mocks.agent.url}/v1`, apiKey: "sk-footer-fixture" },
      models: { [modelId]: { name: modelName } },
    } },
  } }) });
  if (!configured.ok) throw new Error(`Configuring the footer model failed: ${configured.status}`);
  const reloaded = await request(`${mount}/engine/reload`, { method: "POST" });
  // As in configureProvider, engine startup can still be pending after reload.
  if (!reloaded.ok && reloaded.status !== 503 && reloaded.status !== 504) throw new Error(`Reloading the engine failed: ${reloaded.status}`);
  const session = await seed.session(app, { title: "Report status" });
  const nativeSession = `${mount}/opencode2/api/session/${session.sessionId}`;
  const selected = await request(`${nativeSession}/model`, { method: "POST", body: JSON.stringify({ model: { providerID: providerId, id: modelId } }) });
  if (!selected.ok) throw new Error(`Selecting the native model failed: ${selected.status} ${await selected.text()}`);
  for (const turn of [older, latest]) {
    const response = await request(`${nativeSession}/prompt`, { method: "POST", body: JSON.stringify({ text: turn.prompt }) });
    if (!response.ok) throw new Error(`Arranging a completed report turn failed: ${response.status} ${await response.text()}`);
    const deadline = Date.now() + 120_000;
    let completed: Record<string, unknown> | undefined;
    while (Date.now() < deadline) {
      const stored = await request(`${nativeSession}/message`);
      const body: unknown = await stored.json();
      const messages = isRecord(body) && Array.isArray(body.data) ? body.data.filter(isRecord) : [];
      completed = messages.find(message => message.type === "assistant" && message.finish === "stop" && JSON.stringify(message).includes(turn.reply));
      if (completed) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (!completed) throw new Error("The native engine did not complete the report turn within 120 seconds.");
    if (!isRecord(completed.model) || completed.model.providerID !== providerId || completed.model.id !== modelId) {
      throw new Error(`The completed native reply used an unexpected model: ${JSON.stringify(completed)}`);
    }
    const resolved = completed.resolvedModel;
    const resolvedId = isRecord(resolved) ? resolved.modelID ?? resolved.id : completed.resolvedModelID;
    if (typeof resolvedId !== "string") repliesWithoutResolvedMetadata += 1;
  }
  const listed = await request(`${mount}/opencode2/api/model`);
  const catalog: unknown = await listed.json();
  const entries = Array.isArray(catalog) ? catalog : isRecord(catalog) && Array.isArray(catalog.data) ? catalog.data : [];
  const catalogModel = entries.filter(isRecord).find(model => model.providerID === providerId && model.id === modelId);
  if (catalogModel?.name !== modelName) throw new Error(`The native catalog did not preserve the configured human model name: ${JSON.stringify(catalogModel)}`);
  return {
    app, den, session, modelName, older, latest, repliesWithoutResolvedMetadata,
    async touchInput() {
      // Chromium device emulation changes input capabilities, not application state.
      await app.client.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
      await app.client.send("Emulation.setEmulatedMedia", { features: [{ name: "pointer", value: "coarse" }, { name: "hover", value: "none" }] });
    },
  };
}
