import { browserScript, evaluate } from "@openwork/cdp";
import { resolveEvalEngine, type Place, type Seed } from "@openwork/env";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { configureProvider } from "./chat.ts";
import { installSsePressure } from "./session-archive-pressure.ts";

export function permissionPressureMode(): "baseline" | "fixed" {
  const mode = process.env.OPENWORK_PERMISSION_PRESSURE_MODE ?? "fixed";
  if (mode !== "baseline" && mode !== "fixed") throw new Error("OPENWORK_PERMISSION_PRESSURE_MODE must be baseline or fixed");
  return mode;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected fixture object");
  return value;
}
function list(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("Expected fixture list");
  return value.map(record);
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected fixture string");
  return value;
}

type MainRequest = { path: string; method: string; body: string; reply: string; status: number | null; elapsedMs: number | null; failed: boolean; transport: string };

export async function permissionPressure(seed: Seed, context: { place: Place }) {
  if (context.place.kind !== "local" || resolveEvalEngine() !== "v1"
    || process.env.OPENWORK_EVAL_ELECTRON_BINARY || process.env.OPENWORK_EVAL_SURFACES_DIR
    || process.env.OPENWORK_DEV_SHARED_STATE !== "0") {
    throw new Error("Permission pressure requires --local --engine v1 --surface electron, OPENWORK_DEV_SHARED_STATE=0 and no binary/surfaces override");
  }
  await using resources = new AsyncDisposableStack();
  const root = seed.tmpPath("permission-pressure");
  const workspacePath = join(root, "workspace");
  const externalPath = join(root, "external");
  await mkdir(workspacePath, { recursive: true });
  await mkdir(externalPath, { recursive: true });
  resources.defer(() => rm(root, { recursive: true, force: true }));
  const filePath = join(await realpath(externalPath), "probe.txt");
  const marker = "PERMISSION_PRESSURE_FILE_CONTENT";
  await writeFile(filePath, `${marker}\n`);
  await writeFile(join(workspacePath, "opencode.json"), JSON.stringify({
    permission: { read: "allow", external_directory: "ask" },
  }));
  const prompt = "Read the external fixture document for the timeout investigation.";
  const otherPrompt = "Read the external fixture document for the unrelated task.";
  const reply = "The external fixture document was read.";
  const followup = { prompt: "Confirm fresh work after the external read was stopped.", reply: "Fresh work completed after Stop." };
  const definition = seed.mock({ isolatedProcessEnv: true, agentWorkloads: [
    ...[prompt, otherPrompt].map(promptMarker => ({
      promptMarker, latestUserTurn: true, finalReply: reply,
      steps: [{ tool: "read", arguments: { filePath } }],
    })),
    { promptMarker: followup.prompt, latestUserTurn: true, finalReply: followup.reply, steps: [] },
  ] });
  const booted = await definition.boot(context.place);
  const mock = resources.use(booted.handle);
  const inference = async (held = true) => {
    const response = await fetch(`${mock.url}/admin/agent-hold`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ held }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error("Permission mock inference control failed");
    const state = record(await response.json());
    if (typeof state.held !== "boolean" || typeof state.pending !== "number") throw new Error("Malformed inference hold state");
    return { held: state.held, pending: state.pending };
  };
  await inference();
  const providerId = "permission-pressure-mock";
  const modelId = "permission-pressure-model";
  const preload = fileURLToPath(new URL("../fixtures/permission-main-fetch.cjs", import.meta.url));
  const app = await seed.desktop({ name: "permission-pressure", model: `${providerId}/${modelId}`,
    env: { OPENWORK_DEV_SHARED_STATE: "0", NODE_OPTIONS: `--require ${JSON.stringify(preload)}` },
  });
  const workspace = await seed.workspace(app, workspacePath, { create: true });
  await configureProvider(seed, app, workspace.workspaceId, providerId, modelId, {
    provider: { [providerId]: {
      npm: "@ai-sdk/openai-compatible", name: "Permission pressure mock",
      options: { baseURL: `${mock.url}/v1`, apiKey: "sk-eval-fixture" },
      models: { [modelId]: { name: "Permission pressure model" } },
    } },
  });
  const server = await evaluate(app.client, async () => {
    const info = await window.__OPENWORK_ELECTRON__.invokeDesktop("openworkServerInfo");
    if (!info.running || !info.baseUrl) throw new Error("Isolated fixture server unavailable");
    return { baseUrl: info.baseUrl, token: info.ownerToken ?? info.clientToken };
  }, { awaitPromise: true, timeoutMs: 5_000 });
  const origin = new URL(server.baseUrl);
  if (origin.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname) || !server.token) {
    throw new Error("Permission readback requires an authenticated loopback fixture");
  }
  const mount = `/workspace/${encodeURIComponent(workspace.workspaceId)}/opencode`;
  const mainControl = async (configure: boolean): Promise<MainRequest[]> => {
    const value = await evaluate(app.client, browserScript(async (origin, mount, configure) => {
      const result = await window.__OPENWORK_ELECTRON__.invokeDesktop("__fetch", "http://127.0.0.1/__openwork_permission_test_control", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(configure ? { action: "configure", origin, mount } : { action: "state" }),
      });
      const parsed: unknown = JSON.parse(result.body);
      return parsed;
    }, [origin.origin, mount, configure]), { awaitPromise: true, timeoutMs: 5_000 });
    const state = record(value);
    if (state.witness !== "permission-main-fetch-v1") throw new Error("Permission main witness missing");
    return list(state.requests).map(item => ({
      path: text(item.path), method: text(item.method), transport: text(item.transport), failed: item.failed === true,
      body: text(item.body), reply: text(item.reply),
      status: typeof item.status === "number" ? item.status : null,
      elapsedMs: typeof item.elapsedMs === "number" ? item.elapsedMs : null,
    }));
  };
  await mainControl(true);
  const request = async (path: string, body?: Record<string, unknown>): Promise<unknown> => {
    const response = await fetch(`${origin.origin}${mount}${path}`, {
      method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5_000), redirect: "error",
    });
    if (!response.ok) throw new Error(`Fixture ${body ? "setup" : "readback"} failed: ${response.status} ${path}`);
    return response.status === 204 ? null : response.json();
  };
  const create = async (title: string, prompt: string) => {
    const value = record(await request("/session", { title }));
    return { sessionId: text(value.id), title, prompt };
  };
  const target = await create("Permission timeout investigation", prompt);
  const unrelated = await create("Unrelated pending permission", otherPrompt);
  const start = async (session: { sessionId: string; prompt: string }) => {
    await request(`/session/${session.sessionId}/prompt_async`, {
      model: { providerID: providerId, modelID: modelId }, parts: [{ type: "text", text: session.prompt }],
    });
  };
  await start(unrelated);
  await start(target);
  const pressure = resources.use(await installSsePressure(app, [workspace.workspaceId], {
    clickSelector: "button", clickText: "Allow once", failureText: "Request failed", successText: "",
    successWhenClickTargetGone: true,
  }));
  const pending = async () => list(await request("/permission")).map(item => ({
    id: text(item.id), sessionId: text(item.sessionID), permission: text(item.permission), patterns: item.patterns,
  })).sort((a, b) => a.id.localeCompare(b.id));
  const transcript = async (sessionId: string) => list(await request(`/session/${sessionId}/message?limit=30`)).map(message => {
    const info = record(message.info);
    const parts = list(message.parts);
    return {
      id: text(info.id), role: text(info.role), completed: typeof record(info.time).completed === "number",
      text: parts.filter(part => part.type === "text").map(part => text(part.text)).join(""),
      tools: parts.filter(part => part.type === "tool").map(part => {
        const state = record(part.state);
        return { callId: text(part.callID), tool: text(part.tool), status: text(state.status),
          output: typeof state.output === "string" ? state.output : "" };
      }),
    };
  });
  const lifetime = resources.move();
  return {
    ...pressure, app, workspace, target, unrelated, filePath, marker, reply, followup, pending, transcript,
    replyPath: (id: string) => `${mount}/permission/${encodeURIComponent(id)}/reply`,
    mainRequests: () => mainControl(false),
    providerCalls: (promptMarker: string) => mock.agentRequests({ promptMarker }),
    inference: () => inference(),
    releaseInference: () => inference(false),
    async [Symbol.asyncDispose]() { await lifetime.disposeAsync(); },
  };
}
