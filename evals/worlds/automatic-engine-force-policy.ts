import { randomUUID } from "node:crypto";
import type { Seed } from "@openwork/env";
import { browserScript } from "@openwork/cdp";
import { configureProvider } from "./chat.ts";

export const newV2HistoryText = "This reply was written only after switching to OpenCode v2.";
export const newV2Prompt = "Add the new engine checkpoint to this project note.";
export const continuedWorkPrompt = "Continue the project note on the current engine.";
export const continuedWorkText = "The original engine still handles this work.";
export const retainedHistoryText = "Keep this project note readable when the organization changes its engine policy.";

interface EngineStatus {
  engineOrigin: string;
  engineForced: boolean;
  chatRouting: boolean;
  running: boolean;
  automaticRetryAt?: number;
  migration: { state: string; imported: number; total: number; backupPath?: string; startedAt?: string };
}

export async function failedEngineForcePolicy(seed: Seed) {
  return engineForcePolicyWorld(seed, { unavailableV2: true });
}

export async function automaticEngineForcePolicy(seed: Seed) {
  return engineForcePolicyWorld(seed);
}

async function engineForcePolicyWorld(seed: Seed, options: { unavailableV2?: boolean } = {}) {
  const token = randomUUID();
  const hostToken = randomUUID();
  const app = await seed.appWeb({
    name: "automatic-engine-force-policy",
    workspacePath: seed.tmpPath("automatic-engine-force-policy"),
    engine: "v1",
    mocks: { agent: seed.mock({ isolatedProcessEnv: true, agentWorkloads: [
      { promptMarker: newV2Prompt, finalReply: newV2HistoryText, steps: [] },
      { promptMarker: continuedWorkPrompt, finalReply: continuedWorkText, steps: [] },
    ] }) },
    env: {
      // An executable that exits unsuccessfully exercises the real startup
      // failure path on both Bun and Node, without contacting a provider.
      ...(options.unavailableV2 ? { OPENWORK_OPENCODE2_BIN: "/bin/false" } : {}),
      OPENWORK_TOKEN: token, OPENWORK_HOST_TOKEN: hostToken,
      OPENWORK_ENGINE_V2_PREVIEW: "", OPENWORK_ENGINE_FORCE_POLICY: "1",
      OPENWORK_ENGINE_AUTO_UPGRADE: "0", OPENWORK_FRESH_INSTALL_ENGINE: "v1",
    },
  });
  const workspace = await seed.workspace(app, app.workspaceRoot);
  const model = app.mocks.agent;
  if (!model) throw new Error("The isolated model witness was not started");
  await configureProvider(seed, app, workspace.workspaceId, "engine-history", "history-model", {
    provider: { "engine-history": { npm: "@ai-sdk/openai-compatible", name: "History model",
      options: { baseURL: `${model.url}/v1`, apiKey: "sk-local-history" }, models: { "history-model": { name: "History model" } } } },
  }, "v1");

  async function request(path: string, init: { method?: string; body?: string } = {}, expectedStatus?: number) {
    // The host URL is sandbox-loopback remotely. This escape hatch uses the
    // browser's network for shipping HTTP APIs only, never internal UI state.
    const result = await seed.evalIn(app, browserScript(async (url, token, hostToken, init) => {
      const response = await fetch(url, { ...init, headers: {
        Authorization: `Bearer ${token}`, "x-openwork-host-token": hostToken, "Content-Type": "application/json",
      } });
      return { status: response.status, text: await response.text() };
    }, [`${app.openworkUrl}${path}`, token, hostToken, init]), { awaitPromise: true, timeoutMs: 30_000 });
    if (result.status !== expectedStatus && (result.status < 200 || result.status >= 300)) {
      throw new Error(`${init.method ?? "GET"} ${path}: ${result.status} ${result.text}`);
    }
    return new Response(result.status === 204 ? null : result.text, { status: result.status });
  }
  const mount = `/workspace/${workspace.workspaceId}`;
  // The failure control has actual v1 history. The policy-off proof instead
  // creates its chat on v2, so retaining only the old v1 copy cannot pass it.
  const original = options.unavailableV2
    ? await seed.session(app, { title: "Work continues on the current engine" }) : null;
  if (original) await request(`${mount}/opencode/session/${original.sessionId}/message`, {
    method: "POST", body: JSON.stringify({ noReply: true, parts: [{ type: "text", text: retainedHistoryText }] }),
  });
  async function status(): Promise<EngineStatus> {
    return (await request("/experimental/engine-v2-preview/status")).json();
  }
  return {
    app,
    status,
    async v2Idle(): Promise<boolean> {
      const activity: { v2: { verdict: string } | null } = await (await request("/experimental/engine-v2-preview/activity")).json();
      return activity.v2?.verdict === "idle";
    },
    async messages(sessionId = original?.sessionId): Promise<string> {
      if (!sessionId) throw new Error("A visible chat is required for the history read");
      const engine = (await status()).chatRouting ? "opencode2/api" : "opencode";
      return (await request(`${mount}/${engine}/session/${sessionId}/message`)).text();
    },
    async originalMessages(sessionId: string): Promise<string> {
      return (await request(`${mount}/opencode/session/${sessionId}/message`, {}, 404)).text();
    },
    async manualRetry(): Promise<{ status: number; body: string }> {
      const response = await request("/experimental/engine-v2-preview/migrate", {
        method: "POST", body: JSON.stringify({ confirm: true, allowActiveSessions: true }),
      });
      return { status: response.status, body: await response.text() };
    },
    async setOrganizationPolicy(upgrade: boolean): Promise<void> {
      await request("/experimental/engine-v2-preview/force", { method: "POST", body: JSON.stringify({ upgrade }) });
    },
    async chooseV2Manually(): Promise<void> {
      await request("/experimental/engine-v2-preview", { method: "PUT", body: JSON.stringify({ enabled: true, chatRouting: true }) });
    },
  };
}
