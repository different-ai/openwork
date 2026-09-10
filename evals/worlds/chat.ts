import { addInitScript, browserScript, reattachSurface, type Surface } from "@openwork/cdp";
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { evalIn, assertNoLiveSecret, liveOpenAiEnabled, liveOpenAiModel, liveProviderId, provisionLiveOpenAi } from "@openwork/behaviors";
import { resolveEvalEngine, SkipError, type Seed } from "@openwork/env";
import type { MockAgentWorkload, MockMcpHandle } from "@openwork/labs";
import { chatContinuity } from "./chat-continuity.ts";

const repoRoot = resolve(import.meta.dirname, "../..");

type AppSurface = "electron" | "web";

declare global {
  interface Window {
    __modelEffortRequests?: unknown[];
    __openworkSubmissionFault?: { attempts: number; release: () => void };
    __openworkStoppingFault?: {
      state: {
        attempts: number;
        held: number;
        nativeStatus: number | null;
        nativeFailed: boolean;
        released: boolean;
        failed: boolean;
        clickCaptured: boolean;
        trusted: boolean;
        elapsedMs: number | null;
        expired: boolean;
      };
      fail: () => void;
      dispose: () => void;
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordValue(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Mock server did not bind a TCP port.");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
}

function readBody(request: IncomingMessage): Promise<string> {
  request.setEncoding("utf8");
  return new Promise((resolveBody, reject) => {
    let body = "";
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => resolveBody(body));
    request.on("error", reject);
  });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "access-control-allow-origin": "*",
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function completionChunk(id: string, content: string, finishReason: string | null) {
  return {
    id,
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finishReason }],
  };
}

function sendStream(response: ServerResponse, chunks: unknown[], intervalMs = 0): void {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  let index = 0;
  const writeNext = () => {
    const chunk = chunks[index];
    if (chunk !== undefined) {
      response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      index += 1;
      setTimeout(writeNext, intervalMs);
      return;
    }
    response.end("data: [DONE]\n\n");
  };
  writeNext();
}

export async function configureProvider(
  seed: Seed,
  app: Surface,
  workspaceId: string,
  providerId: string,
  modelId: string,
  opencode: Record<string, unknown>,
  engine = resolveEvalEngine(),
): Promise<void> {
  // TODO(primitive): configure a workspace provider and select its model.
  const result = await seed.evalIn(app, browserScript(async (workspaceId, providerId, modelId, defaultModel, opencodeJson) => {
    const port = localStorage.getItem("openwork.server.port");
    const token = localStorage.getItem("openwork.server.token");
    if (!port || !token) return "missing local server credentials";
    const opencode = JSON.parse(opencodeJson);
    const request = async (path: string, init?: RequestInit) => {
      const response = await fetch("http://127.0.0.1:" + port + path, {
        ...init,
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      });
      const text = await response.text();
      if (!response.ok && !(path.endsWith("/engine/reload") && response.status === 504)) {
        return path + " failed: " + response.status + " " + text.slice(0, 500);
      }
      return "ok";
    };
    const patched = await request("/workspace/" + encodeURIComponent(workspaceId) + "/config", {
      method: "PATCH",
      body: JSON.stringify({ opencode }),
    });
    if (patched !== "ok") return patched;
    const reloaded = await request("/workspace/" + encodeURIComponent(workspaceId) + "/engine/reload", { method: "POST" });
    if (reloaded !== "ok") return reloaded;
    const raw = localStorage.getItem("openwork.preferences");
    let preferences: Record<string, unknown> = {};
    try { preferences = raw ? JSON.parse(raw) : {}; } catch { preferences = {}; }
    if (!preferences || typeof preferences !== "object" || Array.isArray(preferences)) preferences = {};
    localStorage.setItem("openwork.preferences", JSON.stringify({
      ...preferences,
      defaultModel: { providerID: providerId, modelID: modelId },
      modelVariant: null,
      providerStepCompleted: true,
    }));
    localStorage.setItem("openwork.defaultModel", defaultModel);
    localStorage.removeItem("openwork.sessionModels." + workspaceId);
    return "ok";
  }, [workspaceId, providerId, modelId, `${providerId}/${modelId}`, JSON.stringify(opencode)]), { awaitPromise: true, timeoutMs: 120_000 });
  if (result !== "ok") throw new Error(`Provider configuration failed: ${String(result)}`);
  await seed.evalIn(app, () => { location.reload(); return true; });
  const ready = await seed.evalIn(app, browserScript(async (workspaceId, engine, providerId, modelId) => {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const base = "http://127.0.0.1:" + localStorage.getItem("openwork.server.port");
      const headers = { Authorization: "Bearer " + localStorage.getItem("openwork.server.token") };
      try {
        const statusResponse = await fetch(base + "/experimental/engine-v2-preview/status", { headers });
        const status = statusResponse.ok ? await statusResponse.json() : null;
        const selected = status ? status.enabled && status.chatRouting : false;
        if ((engine === "v2") !== selected || (!statusResponse.ok && statusResponse.status !== 404)) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          continue;
        }
        const mounted = base + "/workspace/" + encodeURIComponent(workspaceId);
        const response = await fetch(mounted + (engine === "v2" ? "/opencode2/api/model" : "/opencode/session"), { headers });
        if (response.ok && window.__openworkControl) {
          if (engine === "v1") return true;
          const catalog = JSON.stringify(await response.json());
          if (catalog.includes(providerId) && catalog.includes(modelId)) return true;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return false;
  }, [workspaceId, engine, providerId, modelId]), { awaitPromise: true, timeoutMs: 120_000 });
  if (ready !== true) throw new Error(`Selected ${engine} engine did not become ready after provider configuration.`);
}

async function seedControls(
  seed: Seed,
  app: Surface,
  calls: readonly { action: string; args?: unknown }[],
): Promise<void> {
  for (const call of calls) await arrangeControl(seed, app, call.action, call.args);
}

export async function arrangeControl(
  seed: Seed,
  app: Surface,
  action: string,
  args?: unknown,
): Promise<unknown> {
  // TODO(primitive): invoke a named renderer fixture control and await its result.
  return seed.evalIn(app, browserScript(async (action, argsJson) => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const available = window.__openworkControl?.listActions().find((candidate) => candidate.id === action && !candidate.disabled);
      if (available) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const result = await window.__openworkControl.execute(action, JSON.parse(argsJson));
    if (!result?.ok) throw new Error(String(result?.error ?? "control action failed"));
    return result.value;
  }, [action, JSON.stringify(args ?? null)]), { awaitPromise: true, timeoutMs: 120_000 });
}

async function seedSessionRetry(
  seed: Seed,
  app: Surface,
  options: { title?: string } = {},
): Promise<{ sessionId: string; title: string }> {
  const deadline = Date.now() + 60_000;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      return await seed.session(app, options);
    } catch (error) {
      lastError = error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
    }
  }
  throw new Error(`Session creation did not settle: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

export async function emptyChat(seed: Seed) {
  const app = await seed.desktop({ name: "chat-empty" });
  const workspace = await seed.workspace(app, seed.tmpPath("chat-empty"));
  const session = await seedSessionRetry(seed, app);
  return { app, workspace, session };
}

export async function paletteSessionActions(seed: Seed) {
  const app = await seed.desktop({ name: "command-palette-pin-rename" });
  const workspace = await seed.workspace(app, seed.tmpPath("command-palette-pin-rename"));
  const session = await seedSessionRetry(seed, app, { title: "Palette pin rename probe" });
  return { app, workspace, session };
}

async function splitPaneQuestions(
  seed: Seed,
  name: string,
  agentWorkloads: MockAgentWorkload[],
  policy: Record<string, unknown> = { permission: { question: "allow" } },
  surface: AppSurface = "electron",
  options: { createWorkspace?: boolean } = {},
) {
  const providerId = "split-send-mock";
  const modelId = "split-send-model";
  const mock = seed.mock({ isolatedProcessEnv: surface === "web", agentWorkloads });
  // Electron stores realpath'd workspace roots; give the web server the same root
  // so Stop's engine-directory verification matches (macOS /tmp is a symlink).
  const requestedPath = seed.tmpPath(name);
  const workspacePath = surface === "web"
    ? join(realpathSync(dirname(requestedPath)), basename(requestedPath))
    : requestedPath;
  let app: Surface;
  let agentMock: MockMcpHandle;
  if (surface === "web") {
    const web = await seed.appWeb({
      name,
      workspacePath,
      mocks: { agent: mock },
    });
    app = web;
    const configured = web.mocks.agent;
    if (!configured) throw new Error(`The app-web fixture did not boot the ${name} model witness.`);
    agentMock = configured;
  } else {
    const den = await seed.den({ mocks: { agent: mock } });
    app = await seed.desktop({ name, den, as: "admin", model: `${providerId}/${modelId}` });
    agentMock = den.mocks.agent;
  }
  // Worlds whose `policy` must govern the agent create the workspace at the
  // declared tmp path. Without `create`, the seed adopts the first-launch
  // default workspace, which the dev profile places inside the repo checkout on
  // Daytona; the engine then merges the repo's `.opencode/opencode.json`
  // (`"permission": "allow"`) after the workspace's own opencode.json, so a
  // workspace `bash: "ask"` never holds (observed agent ruleset
  // `[* allow, bash ask, * allow]`; the last match wins).
  const workspace = await seed.workspace(app, workspacePath, options.createWorkspace ? { create: true } : {});
  // Arrange an allowed native question tool independently of custom-agent defaults.
  // TODO(primitive): write workspace fixture files through a first-class seed API.
  const questionPolicyWritten = await seed.evalIn(app, browserScript(async (workspaceId, content) => {
    const port = localStorage.getItem("openwork.server.port");
    const token = localStorage.getItem("openwork.server.token");
    const response = await fetch("http://127.0.0.1:" + port + "/workspace/" + encodeURIComponent(workspaceId) + "/files/content", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ path: "opencode.json", content }),
    });
    return response.ok;
  }, [workspace.workspaceId, JSON.stringify(policy)]), { awaitPromise: true });
  if (questionPolicyWritten !== true) throw new Error("Could not arrange the question-tool policy.");
  await configureProvider(seed, app, workspace.workspaceId, providerId, modelId, {
    provider: {
      [providerId]: {
        npm: "@ai-sdk/openai-compatible",
        name: "Split send mock",
        options: { baseURL: `${agentMock.url}/v1`, apiKey: "sk-split-send" },
        models: { [modelId]: { name: "Split send model" } },
      },
    },
  });
  return { app, workspace, mock: agentMock };
}

export async function delegatedQuestionHandoff(seed: Seed) {
  const engine = resolveEvalEngine();
  const delegationTool = engine === "v2" ? "subagent" : "task";
  const rootPrompt = "Delegate choosing the task format, then report the result.";
  const child = {
    prompt: "Help me choose the delegated task format",
    question: "Which format should the child task use?",
    answer: "Child checklist",
    alternative: "Child outline",
  };
  const unrelated = {
    prompt: "Help me choose the unrelated task format",
    question: "Which format should the unrelated task use?",
    answer: "Unrelated outline",
    alternative: "Unrelated checklist",
  };
  const followup = { prompt: "Leave the delegated task stopped and prepare a fresh summary", reply: "Fresh summary finished after stopping the child." };
  const base = await splitPaneQuestions(seed, "delegated-question-handoff", [
    {
      promptMarker: rootPrompt, latestUserTurn: true,
      finalReply: "Unused: return the actual child result.", finalReplyFrom: "last-tool-text",
      steps: [{ tool: delegationTool, arguments: {
        description: "Choose delegated task format", prompt: child.prompt,
        // v2 beta-19086 calls this subagent; foreground must await the child's answer.
        ...(engine === "v2" ? { agent: "general", background: false } : { subagent_type: "general" }),
      } }],
    },
    ...[child, unrelated].map((question): MockAgentWorkload => ({
      promptMarker: question.prompt, latestUserTurn: true,
      finalReply: "Unused: return the actual question result.", finalReplyFrom: "last-tool-text",
      steps: [{ tool: "question", arguments: { questions: [{
        header: "Task format", question: question.question,
        options: [
          { label: question.answer, description: "Use this format" },
          { label: question.alternative, description: "Use the other format" },
        ],
      }] } }],
    })),
    { promptMarker: followup.prompt, latestUserTurn: true, finalReply: followup.reply, steps: [] },
  ], {
    permission: { question: "allow", task: "allow" },
    // Both engines deny questions for general by default; v2 migrates task to subagent.
    agent: { general: { permission: { question: "allow" } } },
  });
  const root = await seedSessionRetry(seed, base.app, { title: "Delegated question parent" });
  const other = await seedSessionRetry(seed, base.app, { title: "Unrelated question root" });
  return { ...base, engine, delegationTool, followup, root: { ...root, prompt: rootPrompt }, child, unrelated: { ...other, ...unrelated } };
}

/** Real native permissions and a provider retry, without synthetic UI events. */
export async function permissionStopRecovery(seed: Seed) {
  const engine = resolveEvalEngine();
  const retry = { prompt: "Prepare the retry reliability summary", reply: "Retry recovery finished." };
  const stopped = { prompt: "Inspect the stopped permission workspace", command: "printf STOP_PERMISSION_WITNESS" };
  const other = { prompt: "Inspect the other permission workspace", command: "printf OTHER_PERMISSION_WITNESS" };
  const followup = { prompt: "Continue with a fresh summary instead", reply: "Fresh work finished after stop." };
  const base = await splitPaneQuestions(seed, "permission-stop-recovery", [
    { promptMarker: retry.prompt, latestUserTurn: true, rateLimitAttempts: 1, finalReply: retry.reply, steps: [] },
    ...[stopped, other].map((item): MockAgentWorkload => ({
      promptMarker: item.prompt, latestUserTurn: true, finalReply: "Permission work finished.",
      steps: [{ tool: engine === "v2" ? "shell" : "bash", arguments: {
        command: item.command, description: "Inspect the permission workspace", timeout: 30_000,
      } }],
    })),
    { promptMarker: followup.prompt, latestUserTurn: true, finalReply: followup.reply, steps: [] },
  ], { permission: { bash: "ask" } }, "electron", { createWorkspace: true });
  const stoppedSession = await seedSessionRetry(seed, base.app, { title: "Stop permission task" });
  const otherSession = await seedSessionRetry(seed, base.app, { title: "Keep permission task" });
  return { ...base, engine, retry, followup, stopped: { ...stopped, ...stoppedSession }, other: { ...other, ...otherSession } };
}

/** Synthetic release/model responses, but real Electron quit, engine teardown, and relaunch. */
export async function restartUpdateTaskWorld(seed: Seed) {
  const engine = resolveEvalEngine();
  const active = { prompt: "Prepare the restart continuity report", title: "Continue after update" };
  const stopped = { prompt: "Prepare the cancelled continuity report", title: "Keep stopped after update" };
  const completed = { prompt: "Prepare the completed continuity report", title: "Keep completed after update", reply: "The completed report is ready." };
  const recovery = { marker: "Continue the interrupted task", reply: "The interrupted report continued after restart." };
  const base = await splitPaneQuestions(seed, "restart-update-task", [
    ...[active, stopped].map((task): MockAgentWorkload => ({
      promptMarker: task.prompt, latestUserTurn: true, finalReply: "The original turn finished without restarting.",
      steps: [{ tool: engine === "v2" ? "shell" : "bash", arguments: {
        command: "sleep 120", description: "Wait for the report input", timeout: 180_000,
      } }],
    })),
    { promptMarker: completed.prompt, latestUserTurn: true, finalReply: completed.reply, steps: [] },
    { promptMarker: recovery.marker, latestUserTurn: true, finalReply: recovery.reply, steps: [] },
  ], { permission: { bash: "allow" } });
  const activeSession = await seedSessionRetry(seed, base.app, { title: active.title });
  const stoppedSession = await seedSessionRetry(seed, base.app, { title: stopped.title });
  const completedSession = await seedSessionRetry(seed, base.app, { title: completed.title });
  const originalTimeOrigin = await evalIn(base.app, () => performance.timeOrigin);
  await seed.evalIn(base.app, () => {
    const currentVersion = "0.18.0";
    window.__openworkReadDesktopVersionMetadataEval = () => ({
      minAppVersion: "0.1.0", latestAppVersion: "9.9.9", publishedDesktopVersions: ["9.9.9"],
    });
    window.__openworkUpdaterEvalBridge = {
      getChannel: async () => ({ channel: "stable", currentVersion }),
      setChannel: async (channel) => ({ channel, currentVersion }),
      check: async () => ({ available: true, channel: "stable", currentVersion, latestVersion: "9.9.9" }),
      download: async () => ({ ok: true }),
      // Do not replace a binary in a journey. Unlike the download-only fixture,
      // confirmation goes through real main-process app.relaunch()/app.quit().
      installAndRestart: async () => {
        await window.__OPENWORK_ELECTRON__.shell.relaunch();
        return { ok: true };
      },
      onDownloadProgress: () => () => {},
    };
  });
  return {
    ...base, engine, recovery,
    active: { ...active, ...activeSession }, stopped: { ...stopped, ...stoppedSession }, completed: { ...completed, ...completedSession },
    async reconnectAfterRestart() {
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        try {
          await reattachSurface(base.app, { timeoutMs: 3_000 });
          const origin = await evalIn(base.app, () => performance.timeOrigin, { timeoutMs: 3_000 });
          if (origin !== originalTimeOrigin) return { originalTimeOrigin, timeOrigin: origin };
        } catch { /* The old renderer and CDP socket disappear during quit. */ }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error("Update confirmation did not relaunch the Electron renderer");
    },
    async [Symbol.asyncDispose]() {
      // The original seed owns the profile and processes; close the relaunched
      // browser before its normal fixture cleanup removes that profile.
      await base.app.client.send("Browser.close").catch(() => undefined);
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const alive = await fetch(`${base.app.handle.cdpUrl}/json/version`, { signal: AbortSignal.timeout(1_000) })
          .then((response) => response.ok, () => false);
        if (!alive) return;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error("Relaunched Electron did not close before profile cleanup");
    },
  };
}

export async function newSplitPrimary(seed: Seed) {
  const primaryPrompt = "Reply to the primary split message";
  const secondaryPrompt = "Reply to the secondary split message";
  const switchPrompt = "Reply after switching the primary session";
  const primaryQuestionPrompt = "Help me choose the main task format";
  const secondaryQuestionPrompt = "Help me choose the side task format";
  const contextPrompt = "Describe your conversation context";
  const { app, workspace } = await splitPaneQuestions(seed, "new-split-session", [
    ...["Main", "Side"].map((pane): MockAgentWorkload => ({
      promptMarker: pane === "Main" ? primaryQuestionPrompt : secondaryQuestionPrompt,
      latestUserTurn: true, finalReply: "Answered the format question.", finalReplyFrom: "last-tool-text",
      steps: [{ tool: "question", arguments: { questions: [{
        header: `${pane} format`, question: `Which format should the ${pane.toLowerCase()} task use?`,
        options: [{ label: `${pane} outline`, description: "A brief overview" }, { label: `${pane} checklist`, description: "A sequence of steps" }],
      }] } }],
    })),
    { promptMarker: contextPrompt, latestUserTurn: true, finalReply: "Conversation context.", finalReplyFrom: "system-text", steps: [] },
    { latestUserTurn: true, promptMarker: primaryPrompt, finalReply: "Primary split received", steps: [] },
    { latestUserTurn: true, promptMarker: secondaryPrompt, finalReply: "Secondary split received", steps: [] },
    { latestUserTurn: true, promptMarker: switchPrompt, finalReply: "Switched session received", steps: [] },
  ]);
  const switchSession = await seedSessionRetry(seed, app, { title: "Split switch target" });
  const session = await seedSessionRetry(seed, app, { title: "New split primary" });
  const splitFacts = () => evalIn(app, () => {
    const context = window.__openworkControl?.context?.();
    const layout = context?.conversations?.layout;
    const primaryPane = document.querySelector<HTMLElement>('[data-workbench-pane="primary"]');
    const secondaryPanes = [...document.querySelectorAll<HTMLElement>('[data-workbench-pane="secondary"]')];
    const secondaryPane = secondaryPanes[0];
    return {
      layoutKind: layout?.kind ?? "",
      focusedPane: (layout?.kind === "split" ? layout.focused : undefined) ?? "",
      focusedComposerSessionId: document.activeElement?.matches('[contenteditable="true"]')
        ? document.activeElement.closest("[data-session-surface-id]")?.getAttribute("data-session-surface-id") ?? ""
        : "",
      primarySessionId: (layout?.kind === "split" ? layout.primarySessionId : undefined) ?? (layout?.kind === "single" ? layout.sessionId : undefined) ?? "",
      secondarySessionId: (layout?.kind === "split" ? layout.secondarySessionId : undefined) ?? "",
      primaryWorkspaceId: (layout?.kind === "split" ? layout.primaryWorkspaceId : undefined) ?? "",
      secondaryWorkspaceId: (layout?.kind === "split" ? layout.secondaryWorkspaceId : undefined) ?? "",
      primarySurfaceSessionId: primaryPane?.querySelector<HTMLElement>('[data-session-surface-id]')
        ?.getAttribute('data-session-surface-id') ?? "",
      secondarySurfaceSessionId: secondaryPane?.querySelector<HTMLElement>('[data-session-surface-id]')
        ?.getAttribute('data-session-surface-id') ?? "",
      secondaryPaneWorkspaceId: secondaryPane?.getAttribute('data-workbench-workspace-id') ?? "",
      secondaryPaneCount: secondaryPanes.length,
      locationHash: window.location.hash,
    };
  });
  const agentContextViaServer = () => evalIn(app, async () => {
    const response = await fetch("http://127.0.0.1:" + localStorage.getItem("openwork.server.port") + "/experimental/ui-control/request", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + localStorage.getItem("openwork.server.token"),
        "content-type": "application/json",
      },
      body: JSON.stringify({ kind: "context" }),
    });
    return response.json();
  }, { awaitPromise: true, timeoutMs: 15_000 });
  return { app, workspace, session, continuity: chatContinuity(app, workspace.workspaceId), splitFacts, agentContextViaServer, primaryPrompt, secondaryPrompt, switchSession, switchPrompt, primaryQuestionPrompt, secondaryQuestionPrompt, contextPrompt };
}

export async function shimmerChat(seed: Seed) {
  const base = await emptyChat(seed);
  await seedControls(seed, base.app, [{ action: "eval.chat_loading.seed" }]);
  return base;
}

export async function focusContinuity(seed: Seed) {
  const app = await seed.desktop({ name: "composer-focus-continuity" });
  const workspace = await seed.workspace(app, seed.tmpPath("composer-focus-continuity"));
  const session = await seedSessionRetry(seed, app);
  return { app, workspace, session };
}

export async function modelPicker(seed: Seed) {
  const den = await seed.den();
  const app = await seed.desktop({ den, as: "admin" });
  const session = await seedSessionRetry(seed, app);
  return { app, den, session };
}

/** Model picker contract through a real native engine and a synthetic provider. */
export async function modelPickerEffortWeb(seed: Seed) {
  const engine = resolveEvalEngine();
  const providerId = "effort-witness";
  const modelId = "reasoning-model";
  const prompt = "Explain why the sky looks blue.";
  const mock = seed.mock({ isolatedProcessEnv: true, agentWorkloads: [{
    promptMarker: prompt, latestUserTurn: true, finalReply: "Air scatters blue light more strongly.", steps: [],
  }] });
  const workspacePath = seed.tmpPath("model-picker-effort");
  const app = await seed.appWeb({ name: "model-picker-effort", workspacePath, mocks: { agent: mock } });
  // Observe model references without consuming or changing the app's requests.
  await addInitScript(app.client, () => {
    window.__modelEffortRequests = [];
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      if (method === "POST" && /\/opencode2\/api\/session\/[^/]+\/model$/.test(new URL(url, location.href).pathname)) {
        const body: unknown = await new Request(input instanceof Request ? input.clone() : input, init).json();
        window.__modelEffortRequests?.push(body);
      }
      return originalFetch(input, init);
    };
  });
  const witness = app.mocks.agent;
  if (!witness) throw new Error("Missing effort provider witness");
  const workspace = await seed.workspace(app, workspacePath);
  await configureProvider(seed, app, workspace.workspaceId, providerId, modelId, { provider: {
    [providerId]: {
      npm: "@ai-sdk/openai-compatible", name: "Effort witness",
      options: { baseURL: `${witness.url}/v1`, apiKey: "synthetic-effort-key" },
      models: {
        [modelId]: { name: "Reasoning witness", reasoning: true, variants: {
          low: { reasoningEffort: "low" }, high: { reasoningEffort: "high" },
          CustomExact: { reasoningEffort: "low" },
          hidden: { disabled: true, reasoningEffort: "high" },
        } },
        standard: { name: "Standard witness", reasoning: false },
      },
    },
  } }, engine);
  const session = await seedSessionRetry(seed, app, { title: "Model effort contract" });
  return { app, engine, workspace, session, prompt, providerId, modelId,
    modelRequests: () => seed.evalIn(app, () => window.__modelEffortRequests ?? []),
    runtimeFacts: async () => ({
      ...await seed.evalIn(app, () => ({ browser: navigator.userAgent, electronBridge: Boolean(window.__OPENWORK_ELECTRON__) })),
      sourceSha: app.actualSourceSha,
    }),
    readNative: (path: string) => seed.evalIn(app, browserScript(async (path) => {
      const base = "http://127.0.0.1:" + localStorage.getItem("openwork.server.port");
      const response = await fetch(base + path, {
        headers: { Authorization: "Bearer " + localStorage.getItem("openwork.server.token") },
        signal: AbortSignal.timeout(15_000),
      });
      const body: unknown = await response.json();
      return { status: response.status, body };
    }, [path]), { awaitPromise: true, timeoutMs: 20_000 }),
    requests: async () => (await witness.agentRequests({ promptMarker: prompt })).filter((request) => request.kind === "final"),
  };
}

export async function connectionsMenu(seed: Seed) {
  const connector = seed.mock();
  const den = await seed.den({ mocks: { connector } });
  const connections: { id: string; name: string }[] = [];
  for (let index = 1; index <= 14; index += 1) {
    connections.push(await seed.orgConnection(den.admin, {
      name: `Composer connection ${String(index).padStart(2, "0")}`,
      url: den.mocks.connector.mcpUrl,
      authType: "oauth",
      credentialMode: "per_member",
      access: { orgWide: true },
    }));
  }
  const app = await seed.desktop({ den, as: "admin" });
  const session = await seedSessionRetry(seed, app);
  // TODO(primitive): click a button by its title when it has no accessible name.
  const opened = await seed.evalIn(app, () => {
    const trigger = document.querySelector<HTMLButtonElement>('button[title="Agents, commands, skills, plugins, and connections"]');
    if (!(trigger instanceof HTMLButtonElement)) return false;
    trigger.click();
    return true;
  });
  if (opened !== true) throw new Error("Composer capability menu did not open.");
  return { app, den, session, connections };
}

async function startManualApprovalServer(approvalTimeoutMs: number) {
  const script = `
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { startServer } = await import("./src/server.ts");
    const root = mkdtempSync(join(tmpdir(), "openwork-attachment-spec-"));
    const server = await startServer({
      host: "127.0.0.1", port: 0, token: "owt_spec_token", hostToken: "owt_spec_host_token",
      approval: { mode: "manual", timeoutMs: ${approvalTimeoutMs} }, corsOrigins: ["*"],
      workspaces: [{ id: "ws_spec", name: "Workspace", path: root, preset: "starter", workspaceType: "local" }],
      authorizedRoots: [root], readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli",
      logFormat: "pretty", logRequests: false,
    });
    console.log("SPEC_SERVER_PORT:" + server.port);
    setInterval(() => {}, 60000);
  `;
  // Isolate runtime state: without this the spawned server reads the host's
  // ~/.config/openwork/runtime.sqlite, and a persisted managed policy there
  // turns every write into an instant 403 policy_unavailable.
  const child = spawn("bun", ["--conditions=development", "-e", script], {
    cwd: join(repoRoot, "apps", "server"),
    env: { ...process.env, OPENWORK_RUNTIME_DB: join(mkdtempSync(join(tmpdir(), "openwork-attachment-spec-runtime-")), "runtime.sqlite") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const port = await new Promise<number>((resolvePort, reject) => {
    const timer = setTimeout(() => reject(new Error("Standalone openwork-server did not report a port within 30s.")), 30_000);
    let buffered = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffered += chunk;
      const match = buffered.match(/SPEC_SERVER_PORT:(\d+)/);
      if (match?.[1]) {
        clearTimeout(timer);
        resolvePort(Number(match[1]));
      }
    });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Standalone openwork-server exited early (code ${code}): ${(stderr || buffered).slice(0, 500)}`));
    });
    child.on("error", reject);
  });
  return {
    base: `http://127.0.0.1:${port}`,
    token: "owt_spec_token",
    dispose: () => { child.kill("SIGKILL"); },
  };
}

export async function attachmentUpload(seed: Seed) {
  const providerId = "attachment-upload-mock";
  const modelId = "attachment-upload-model";
  const reply = "attachment upload loading proof";
  const mock = seed.mock({
    agentWorkloads: [{
      promptMarker: "Describe the attached image.",
      finalReply: reply,
      steps: [{
        tool: "bash",
        arguments: {
          command: "printf '%s\\n' 'attachment-upload-ready'",
          timeout: 30_000,
          description: "Acknowledge the attachment upload",
        },
      }],
    }],
  });
  const den = await seed.den({ mocks: { agent: mock } });
  const approvalTimeoutMs = 3_000;
  const gateway = await startManualApprovalServer(approvalTimeoutMs);
  try {
    const uploadForm = new FormData();
    uploadForm.append("file", new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 9, 9, 9, 9])], "screenshot.png", { type: "image/png" }));
    const uploadStartedAt = Date.now();
    const uploadResponse = await fetch(`${gateway.base}/workspace/ws_spec/inbox?path=${encodeURIComponent("chat-attachments/s1/att-1-screenshot.png")}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${gateway.token}` },
      body: uploadForm,
    });
    const uploadElapsedMs = Date.now() - uploadStartedAt;
    const writeStartedAt = Date.now();
    const writeResponse = await fetch(`${gateway.base}/workspace/ws_spec/files/content`, {
      method: "POST",
      headers: { Authorization: `Bearer ${gateway.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ path: "notes/unapproved.md", content: "# should not land\n" }),
    });
    const writeElapsedMs = Date.now() - writeStartedAt;

    const app = await seed.desktop({ den, as: "admin", model: `${providerId}/${modelId}` });
    const workspace = await seed.workspace(app, seed.tmpPath("attachment-upload"));
    await configureProvider(seed, app, workspace.workspaceId, providerId, modelId, {
      provider: {
        [providerId]: {
          npm: "@ai-sdk/openai-compatible",
          name: "Attachment upload mock",
          options: { baseURL: `${den.mocks.agent.url}/v1`, apiKey: "sk-attachment-upload" },
          models: { [modelId]: { name: "Attachment upload model" } },
        },
      },
    });
    const session = await seedSessionRetry(seed, app);
    return {
      app,
      workspace,
      session,
      async holdUploads() {
        await seed.evalIn(app, () => {
          const originalFetch = window.fetch;
          let release = () => {};
          const gate = new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("Attachment upload gate timed out")), 60_000);
            release = () => { clearTimeout(timer); resolve(); };
          });
          const fault = {
            attempts: 0,
            release: () => { release(); window.fetch = originalFetch; },
          };
          window.__openworkSubmissionFault = fault;
          window.fetch = async (input, init) => {
            const url = input instanceof Request ? input.url : String(input);
            const method = init?.method ?? (input instanceof Request ? input.method : "GET");
            // The client posts multipart to /workspace/<id>/inbox with the target
            // path as a form field, not a query parameter.
            const formPath = init?.body instanceof FormData ? String(init.body.get("path") ?? "") : "";
            if (method === "POST" && /\/inbox(\?|$)/.test(url) && `${url} ${formPath}`.includes("chat-attachments")) {
              fault.attempts++;
              await gate;
            }
            return originalFetch(input, init);
          };
        });
      },
      async releaseUploads() {
        await seed.evalIn(app, () => window.__openworkSubmissionFault?.release());
      },
      approvalTimeoutMs,
      uploadStatus: uploadResponse.status,
      uploadElapsedMs,
      writeStatus: writeResponse.status,
      writeElapsedMs,
      async [Symbol.asyncDispose]() {
        gateway.dispose();
      },
    };
  } catch (error) {
    gateway.dispose();
    throw error;
  }
}

export const renderCycleFirstReply = "Historical response is complete.";
export const renderCycleMarker = "STREAM_RENDER_CYCLE";
export const renderCycleChunks = Array.from({ length: 48 }, (_, index) => `chunk-${index + 1} `);

export async function renderCycle(seed: Seed) {
  const providerId = "chat-render-cycle-mock";
  const modelId = "chat-render-cycle-model";
  const requests: string[] = [];
  let completionIndex = 0;
  const provider = createServer((request, response) => {
    const url = request.url ?? "";
    requests.push(`${request.method ?? "UNKNOWN"} ${url}`);
    if (request.method === "GET" && url.startsWith("/v1/models")) {
      sendJson(response, 200, { object: "list", data: [{ id: modelId, object: "model" }] });
      return;
    }
    if (request.method !== "POST" || (url !== "/v1/chat/completions" && url !== "/chat/completions")) {
      sendJson(response, 404, { error: { message: "not found" } });
      return;
    }
    void readBody(request).then((body) => {
      const streaming = body.includes(renderCycleMarker);
      const contents = streaming ? renderCycleChunks : [renderCycleFirstReply];
      completionIndex += 1;
      const id = `chatcmpl-render-cycle-${completionIndex}`;
      const chunks = [
        { id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
        ...contents.map((content) => completionChunk(id, content, null)),
        completionChunk(id, "", "stop"),
      ];
      setTimeout(() => sendStream(response, chunks, streaming ? 35 : 0), streaming ? 0 : 1_000);
    });
  });
  const baseUrl = await listen(provider);
  try {
    const app = await seed.desktop({ name: "chat-render-cycle-stability", model: `${providerId}/${modelId}` });
    const workspace = await seed.workspace(app, seed.tmpPath("chat-render-cycle"));
    await configureProvider(seed, app, workspace.workspaceId, providerId, modelId, {
      provider: {
        [providerId]: {
          npm: "@ai-sdk/openai-compatible",
          name: "Chat render-cycle mock",
          options: { baseURL: `${baseUrl}/v1`, apiKey: "sk-chat-render-cycle" },
          models: { [modelId]: { name: "Chat render-cycle model" } },
        },
      },
    });
    // TODO(primitive): enable the renderer profiler before desktop launch.
    await seed.evalIn(app, () => {
      localStorage.setItem("openwork.debug.profiler", "1");
      localStorage.removeItem("openwork.debug.profilerOverlay");
      location.reload();
      return true;
    });
    const controlsReady = await seed.evalIn(app, async () => {
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        if (window.__openworkControl?.listActions().some((action) => action.id === "session.create_task" && !action.disabled)) return true;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return false;
    }, { awaitPromise: true, timeoutMs: 120_000 });
    if (controlsReady !== true) throw new Error("Session controls did not return after enabling the profiler.");
    const session = await seedSessionRetry(seed, app);
    await seed.composerText(app, `Reply with exactly: ${renderCycleFirstReply}`);
    // TODO(primitive): send an arranged historical turn and await its completion.
    const historical = await seed.evalIn(app, browserScript(async (expectedReply) => {
      const sent = await window.__openworkControl.execute("composer.send", null);
      if (!sent?.ok) throw new Error(String(sent?.error ?? "composer.send failed"));
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        if (document.body.innerText.includes(expectedReply)) return true;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return false;
    }, [renderCycleFirstReply]), { awaitPromise: true, timeoutMs: 120_000 });
    if (historical !== true) throw new Error(`Historical turn did not complete. Requests: ${requests.join("; ")}`);
    return {
      app,
      workspace,
      session,
      async [Symbol.asyncDispose]() { await close(provider); },
    };
  } catch (error) {
    await close(provider);
    throw error;
  }
}

export async function streamedToolHistory(seed: Seed) {
  if (resolveEvalEngine() !== "v1") throw new SkipError("native v1 transcript history (OPENWORK_EVAL_ENGINE=v1)");
  const providerId = "streamed-history-mock";
  const modelId = "streamed-history-model";
  const prompt = "Continue the history review and report the latest tool result.";
  const opening = "History review is advancing.";
  const middle = "The next review section is arriving.";
  const closing = "History review is complete.";
  const answer = [opening, "Earlier work remains available. ".repeat(16), middle,
    "The current answer continues to grow. ".repeat(20), closing].join("\n\n");
  const history = Array.from({ length: 150 }, (_, index) => `Settled history ${String(index + 1).padStart(3, "0")}.`);
  const toolNames = Array.from({ length: 20 }, (_, index) => `history-tool-${String(index + 1).padStart(2, "0")}`);
  const latestTool = "latest-tool-result";
  // The complete URL exists only in output, not in the tool input or final reply.
  const command = (name: string) => `printf '%s%s/%s\\n' 'http://' '127.0.0.1:43123' '${name}'`;
  const mock = seed.mock({ agentWorkloads: [{
    promptMarker: prompt, latestUserTurn: true, finalReply: answer, finalReplyChunkSize: 2,
    steps: [{ tool: "bash", arguments: { command: command(latestTool), description: "Read the latest history result" } }],
  }] });
  const den = await seed.den({ mocks: { agent: mock } });
  const app = await seed.desktop({ name: "streamed-tool-history", den, as: "admin", model: `${providerId}/${modelId}` });
  const workspace = await seed.workspace(app, seed.tmpPath("streamed-tool-history"));
  const profile = await seed.api(den.admin, "/v1/me");
  if (!profile.response.ok || !isRecord(profile.body) || !isRecord(profile.body.user)
    || typeof profile.body.user.id !== "string" || !profile.body.user.id.trim()) {
    throw new Error("Streamed history fixture could not resolve its authenticated principal");
  }
  const principalId = profile.body.user.id.trim();
  await configureProvider(seed, app, workspace.workspaceId, providerId, modelId, {
    permission: { bash: "allow" },
    provider: { [providerId]: {
      npm: "@ai-sdk/openai-compatible", name: "Streamed history mock",
      options: { baseURL: `${den.mocks.agent.url}/v1`, apiKey: "sk-streamed-history" },
      models: { [modelId]: { name: "Streamed history model" } },
    } },
  });
  const neighbor = await seedSessionRetry(seed, app, { title: "Unrelated history review" });
  const session = await seedSessionRetry(seed, app, { title: "Long tool history" });
  const historyPath = `/workspace/${encodeURIComponent(workspace.workspaceId)}/opencode/session/${encodeURIComponent(session.sessionId)}/message`;
  // Persist through native HTTP boundaries while the real SSE subscriber builds
  // its cache. Never inject renderer messages or import the merge implementation.
  await seed.evalIn(app, browserScript(async (historyPath, history, commands, providerId, modelId) => {
    const base = "http://127.0.0.1:" + localStorage.getItem("openwork.server.port");
    const headers = { Authorization: "Bearer " + localStorage.getItem("openwork.server.token"), "Content-Type": "application/json" };
    const deadline = Date.now() + 150000;
    const post = async (path: string, body: unknown) => {
      if (Date.now() >= deadline) throw new Error("Native history arrangement exceeded 150 seconds");
      const response = await fetch(base + path, {
        method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) throw new Error("Native history arrangement failed: " + response.status);
      return response.json();
    };
    for (const text of history) {
      await post(historyPath, { noReply: true, model: { providerID: providerId, modelID: modelId }, parts: [{ type: "text", text }] });
      // Wait for each native event to reach the transcript, including the oldest
      // entries that will no longer fit in a later bounded snapshot.
      const visibleDeadline = Math.min(deadline, Date.now() + 10000);
      while (![...document.querySelectorAll<HTMLElement>('[data-message-role="user"]')].some(node => node.innerText.includes(text))) {
        if (Date.now() >= visibleDeadline) throw new Error("Native history event did not render: " + text);
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    for (const command of commands) {
      const result = await post(historyPath.replace(/\/message$/, "/shell"), {
        agent: "build", model: { providerID: providerId, modelID: modelId }, command,
      });
      if (!Array.isArray(result.parts) || !result.parts.some((part: { type?: string; state?: { status?: string } }) => part.type === "tool" && part.state?.status === "completed")) {
        throw new Error("Native shell history did not complete");
      }
    }
  }, [historyPath, history, toolNames.map(command), providerId, modelId]), { awaitPromise: true, timeoutMs: 185_000 });
  return { app, workspace, session, neighbor, principalId, historyPath, history, toolNames, latestTool, prompt, opening, middle, closing };
}

export const streamedMarkdownMarker = "STREAM_MARKDOWN_ANSWER";
export const streamedMarkdownReasoning = "Preparing the formatted response.";
/** A multi-block answer: heading, prose, list, table, fenced code, closing prose. */
export const streamedMarkdownAnswer = [
  "## Streamed answer heading",
  "",
  "Opening paragraph with **bold emphasis** and `inline-code.ts` in it.",
  "",
  "- alpha list item",
  "- beta list item",
  "",
  "| Column | Value |",
  "| --- | --- |",
  "| gamma row | 42 |",
  "",
  "```ts",
  "const streamed = \"delta\";",
  "```",
  "",
  "[Play video](clip.mp4)",
  "",
  "Closing paragraph epsilon.",
].join("\n");

/**
 * The answer arrives in small content deltas from the shared agent mock, which
 * the placement boots next to Den so the engine can reach it on Daytona too.
 */
export async function streamedMarkdown(seed: Seed) {
  const providerId = "streamed-markdown-mock";
  const modelId = "streamed-markdown-model";
  const mock = seed.mock({
    agentWorkloads: [{
      promptMarker: streamedMarkdownMarker,
      finalReply: streamedMarkdownAnswer,
      finalReasoning: streamedMarkdownReasoning,
      // Allow live reasoning inspection over remote CDP before the mid-turn reload.
      finalReplyChunkSize: 1,
      finalReplyDelayMs: 1500,
      steps: [],
    }],
  });
  const den = await seed.den({ mocks: { agent: mock } });
  const app = await seed.desktop({ den, as: "admin", model: `${providerId}/${modelId}` });
  const workspace = await seed.workspace(app, seed.tmpPath("streamed-markdown-answer"));
  await configureProvider(seed, app, workspace.workspaceId, providerId, modelId, {
    provider: {
      [providerId]: {
        npm: "@ai-sdk/openai-compatible",
        name: "Streamed markdown mock",
        options: { baseURL: `${den.mocks.agent.url}/v1`, apiKey: "sk-streamed-markdown" },
        models: { [modelId]: { name: "Streamed markdown model", reasoning: true } },
      },
    },
  });
  // A tiny H.264 clip, served through the same authenticated file endpoint as user files.
  await seed.evalIn(app, browserScript(async (workspaceId, dataBase64) => {
    const base = "http://127.0.0.1:" + localStorage.getItem("openwork.server.port");
    const response = await fetch(base + "/workspace/" + encodeURIComponent(workspaceId) + "/files/raw", {
      method: "POST",
      headers: { Authorization: "Bearer " + localStorage.getItem("openwork.server.token"), "Content-Type": "application/json" },
      body: JSON.stringify({ path: "clip.mp4", dataBase64 }),
    });
    if (!response.ok) throw new Error("Video fixture write failed: " + response.status);
  }, [workspace.workspaceId, (await readFile(new URL("../fixtures/assistant-video.mp4", import.meta.url))).toString("base64")]), { awaitPromise: true });
  const engine = resolveEvalEngine();
  const ready = await seed.evalIn(app, browserScript(async (workspaceId, engine, providerId, modelId) => {
    const base = "http://127.0.0.1:" + localStorage.getItem("openwork.server.port");
    const headers = { Authorization: "Bearer " + localStorage.getItem("openwork.server.token") };
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const status = await (await fetch(base + "/experimental/engine-v2-preview/status", { headers })).json();
      if (engine === "v1" && !status.chatRouting) return true;
      if (engine === "v2" && status.running && status.chatRouting) {
        const response = await fetch(base + "/workspace/" + workspaceId + "/opencode2/api/model", { headers });
        if (response.ok) {
          const catalog = JSON.stringify(await response.json());
          if (catalog.includes(providerId) && catalog.includes(modelId)) return true;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    return false;
  }, [workspace.workspaceId, engine, providerId, modelId]), { awaitPromise: true, timeoutMs: 65000 });
  if (ready !== true) throw new Error(`Selected ${engine} engine was not ready for the streaming journey`);
  const session = await seedSessionRetry(seed, app);
  return { app, den, workspace, session,
    async holdNextSubmission() {
      await seed.evalIn(app, () => {
        const originalFetch = window.fetch;
        const fault = { attempts: 0, release: () => {} };
        window.__openworkSubmissionFault = fault;
        window.fetch = async (input, init) => {
          const url = input instanceof Request ? input.url : String(input);
          const method = init?.method ?? (input instanceof Request ? input.method : "GET");
          if (method === "POST" && /\/session\/[^/]+\/(prompt_async|prompt)(\?|$)/.test(url)) {
            fault.attempts++;
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, 30_000);
              fault.release = () => { clearTimeout(timer); resolve(); };
            });
            window.fetch = originalFetch;
            return new Response(JSON.stringify({ name: "SubmissionUnavailable", message: "Submission unavailable" }), {
              status: 503, headers: { "content-type": "application/json" },
            });
          }
          return originalFetch(input, init);
        };
      });
    },
    async submissionAttempts() {
      return seed.evalIn(app, () => window.__openworkSubmissionFault?.attempts ?? 0);
    },
    async rejectSubmission() {
      await seed.evalIn(app, () => window.__openworkSubmissionFault?.release());
    },
    async videoState(play = false) {
      return seed.evalIn(app, browserScript(async (play) => {
        const video = document.querySelector<HTMLVideoElement>('video[data-openwork-video-path="clip.mp4"]');
        if (!video) return null;
        if (play) await video.play();
        return { controls: video.controls, autoplay: video.autoplay, ready: video.readyState >= 2,
          paused: video.paused, time: video.currentTime, error: video.error?.message ?? null };
      }, [play]), { awaitPromise: true });
    },
  };
}

const htmlToolName = "explode_html";
export const htmlClosingReply = "The session recovered after the failed upstream call.";
export const htmlSummary = "Upstream returned an HTML error page (502 Bad Gateway)";
const htmlError = `<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body><h1>502 Bad Gateway</h1>${"Z".repeat(1_024 * 1_024)}</body></html>`;

export async function clampHtml(seed: Seed) {
  const providerId = "clamp-html-errors-mock";
  const modelId = "clamp-html-errors-model";
  let toolsListed = 0;
  let toolCalls = 0;
  let closingRounds = 0;
  const mock = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/v1/models") {
        sendJson(response, 200, { object: "list", data: [{ id: modelId, object: "model" }] });
        return;
      }
      if (url.pathname === "/mcp") {
        if (request.method === "GET") {
          sendJson(response, 405, { error: "method_not_allowed" });
          return;
        }
        const raw = await readBody(request);
        const parsed: unknown = raw.trim() ? JSON.parse(raw) : {};
        const messages = Array.isArray(parsed) ? parsed : [parsed];
        const replies: Record<string, unknown>[] = [];
        let delayMs = 0;
        for (const candidate of messages) {
          if (!isRecord(candidate)) continue;
          if (candidate.method === "tools/list") toolsListed += 1;
          if (candidate.method === "tools/call") {
            toolCalls += 1;
            delayMs = 4_000;
          }
          if (candidate.id === undefined) continue;
          const method = typeof candidate.method === "string" ? candidate.method : "";
          if (method === "initialize") replies.push({
            jsonrpc: "2.0", id: candidate.id,
            result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "html-error-mcp", version: "1.0.0" } },
          });
          else if (method === "tools/list") replies.push({
            jsonrpc: "2.0", id: candidate.id,
            result: { tools: [{ name: htmlToolName, title: "HTML upstream failure", description: "Returns a deterministic upstream HTML error page.", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] },
          });
          else if (method === "tools/call") replies.push({ jsonrpc: "2.0", id: candidate.id, error: { code: -32_000, message: htmlError } });
          else replies.push({ jsonrpc: "2.0", id: candidate.id, result: {} });
        }
        if (replies.length === 0) {
          response.writeHead(202, { "access-control-allow-origin": "*" });
          response.end();
          return;
        }
        if (delayMs) await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
        sendJson(response, 200, Array.isArray(parsed) ? replies : replies[0]);
        return;
      }
      if (request.method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions")) {
        const raw = await readBody(request);
        const parsed: unknown = JSON.parse(raw);
        if (!isRecord(parsed)) throw new Error("Mock provider received a non-object request.");
        const requestTools = parsed.tools;
        const id = "chatcmpl-clamp-html-errors";
        if (!Array.isArray(requestTools) || requestTools.length === 0) {
          sendStream(response, [{ id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }, completionChunk(id, "Session title", null), completionChunk(id, "", "stop")], 400);
          return;
        }
        const messages = parsed.messages;
        if (Array.isArray(messages) && messages.some((message) => recordValue(message, "role") === "tool")) {
          closingRounds += 1;
          sendStream(response, [{ id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }, completionChunk(id, htmlClosingReply, null), completionChunk(id, "", "stop")], 400);
          return;
        }
        let toolName: string | null = null;
        for (const tool of requestTools) {
          const fn = recordValue(tool, "function");
          const name = recordValue(fn, "name");
          if (typeof name === "string" && name.endsWith(htmlToolName)) toolName = name;
        }
        if (!toolName) {
          sendStream(response, [{ id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }, completionChunk(id, "The deterministic MCP error tool was unavailable.", null), completionChunk(id, "", "stop")], 400);
          return;
        }
        sendStream(response, [
          { id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
          { id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_html_error", type: "function", function: { name: toolName, arguments: "{}" } }] }, finish_reason: null }] },
          { id, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        ], 400);
        return;
      }
      sendJson(response, 404, { error: { message: "not found" } });
    })().catch((error: unknown) => {
      if (!response.headersSent) sendJson(response, 500, { error: String(error) });
      else response.destroy(error instanceof Error ? error : undefined);
    });
  });
  const baseUrl = await listen(mock);
  try {
    const app = await seed.desktop({ name: "clamp-html-errors", model: `${providerId}/${modelId}` });
    const workspace = await seed.workspace(app, seed.tmpPath("clamp-html-errors"));
    await configureProvider(seed, app, workspace.workspaceId, providerId, modelId, {
      provider: {
        [providerId]: {
          npm: "@ai-sdk/openai-compatible", name: "Clamp HTML errors mock",
          options: { baseURL: `${baseUrl}/v1`, apiKey: "sk-clamp-html-errors" },
          models: { [modelId]: { name: "Clamp HTML errors model", tool_call: true } },
        },
      },
      mcp: { "html-error": { type: "remote", url: `${baseUrl}/mcp`, enabled: true, oauth: false } },
    });
    const session = await seedSessionRetry(seed, app);
    return {
      app,
      workspace,
      session,
      counts: () => ({ toolsListed, toolCalls, closingRounds }),
      async [Symbol.asyncDispose]() { await close(mock); },
    };
  } catch (error) {
    await close(mock);
    throw error;
  }
}

type QueueRequest = { rawBody: string; lastUserText: string };

function lastUserText(rawBody: string): string {
  let parsed: unknown;
  try { parsed = JSON.parse(rawBody); } catch { return ""; }
  if (!isRecord(parsed) || !Array.isArray(parsed.messages)) return "";
  for (let index = parsed.messages.length - 1; index >= 0; index -= 1) {
    const message = parsed.messages[index];
    if (!isRecord(message) || message.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) return message.content.flatMap((part) => (
      isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []
    )).join("");
  }
  return "";
}

async function writeProviderConfig(path: string, providerId: string, modelId: string, modelName: string, baseUrl: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "opencode.json"), `${JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    provider: {
      [providerId]: {
        npm: "@ai-sdk/openai-compatible",
        name: modelName,
        options: { baseURL: baseUrl, apiKey: "sk-openwork-eval" },
        models: { [modelId]: { name: modelName } },
      },
    },
  }, null, 2)}\n`);
}

async function selectModelInWorld(seed: Seed, app: Awaited<ReturnType<Seed["desktop"]>>, modelName: string): Promise<void> {
  // TODO(primitive): select a model as arranged state.
  const selected = await seed.evalIn(app, browserScript(async (modelName) => {
    const deadline = Date.now() + 60000;
    if (!document.querySelector<HTMLInputElement>('input[placeholder="Search providers and models..."]')) {
      const result = await window.__openworkControl.execute("session.model_picker.open", null);
      if (!result?.ok) return false;
    }
    while (Date.now() < deadline) {
      const input = document.querySelector<HTMLInputElement>('input[placeholder="Search providers and models..."]');
      if (input instanceof HTMLInputElement && input.value !== modelName) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        setter?.call(input, modelName);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      const dialog = document.querySelector<HTMLElement>('[data-slot="dialog-content"]');
      const item = [...(dialog?.querySelectorAll("button") ?? [])]
        .find((candidate) => !candidate.disabled && (candidate.textContent ?? "").includes(modelName));
      if (item instanceof HTMLElement) {
        item.click();
        while (Date.now() < deadline) {
          if (!document.querySelector<HTMLInputElement>('input[placeholder="Search providers and models..."]')) return true;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  }, [modelName]), { awaitPromise: true, timeoutMs: 120_000 });
  if (selected !== true) throw new Error(`Model ${modelName} was not selectable.`);
}

export const awayFirstPrompt = "away-drain first task";
export const awayQueuedPrompt = "away-drain queued follow-up";
export const awayFirstReply = "away-drain first reply";
export const awayQueuedReply = "away-drain queued reply";

export async function queuedDrainAway(seed: Seed) {
  const providerId = "away-drain-mock";
  const modelId = "away-drain-model";
  const modelName = "Away drain model";
  const requests: QueueRequest[] = [];
  let releaseFirst: () => void = () => undefined;
  const firstGate = new Promise<void>((resolveGate) => { releaseFirst = resolveGate; });
  const provider = createServer((request, response) => {
    const url = request.url ?? "";
    if (request.method === "GET" && url.startsWith("/v1/models")) {
      sendJson(response, 200, { object: "list", data: [{ id: modelId, object: "model" }] });
      return;
    }
    if (request.method !== "POST" || (url !== "/v1/chat/completions" && url !== "/chat/completions")) {
      sendJson(response, 404, { error: { message: "not found" } });
      return;
    }
    void readBody(request).then((rawBody) => {
      let parsed: unknown;
      try { parsed = JSON.parse(rawBody); } catch { parsed = null; }
      const isMain = isRecord(parsed) && Array.isArray(parsed.tools) && parsed.tools.length > 0;
      if (isMain) requests.push({ rawBody, lastUserText: lastUserText(rawBody) });
      const reply = !isMain ? "Away drain session title" : rawBody.includes(awayQueuedPrompt) ? awayQueuedReply : awayFirstReply;
      const id = `chatcmpl-away-drain-${requests.length}`;
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`);
      const finish = () => {
        response.write(`data: ${JSON.stringify(completionChunk(id, reply, null))}\n\n`);
        response.write(`data: ${JSON.stringify(completionChunk(id, "", "stop"))}\n\n`);
        response.end("data: [DONE]\n\n");
      };
      if (isMain && !rawBody.includes(awayQueuedPrompt)) void firstGate.then(finish);
      else setTimeout(finish, 200);
    });
  });
  const baseUrl = await listen(provider);
  try {
    const workspacePathA = seed.tmpPath("away-drain-a");
    const workspacePathB = seed.tmpPath("away-drain-b");
    await Promise.all([
      writeProviderConfig(workspacePathA, providerId, modelId, modelName, `${baseUrl}/v1`),
      writeProviderConfig(workspacePathB, providerId, modelId, modelName, `${baseUrl}/v1`),
    ]);
    const app = await seed.desktop({ name: "queued-drain-while-away", model: `${providerId}/${modelId}` });
    const workspaceA = await seed.workspace(app, workspacePathA);
    const sessionA = await seedSessionRetry(seed, app, { title: "Chat A" });
    await selectModelInWorld(seed, app, modelName);
    return {
      app,
      workspaceA,
      workspacePathB,
      sessionA,
      requests,
      releaseFirst,
      async [Symbol.asyncDispose]() {
        releaseFirst();
        await close(provider);
      },
    };
  } catch (error) {
    releaseFirst();
    await close(provider);
    throw error;
  }
}

type SequentialRequestLabel = "first" | "one" | "two" | "unexpected";
type SequentialRequest = { label: SequentialRequestLabel; lastUserText: string };

export const sequentialFirstPrompt = "Start the long deterministic task for sequential queue proof.";
export const sequentialQueuedOne = "Queued follow-up ONE for sequential drain proof.";
export const sequentialQueuedTwo = "Queued follow-up TWO for sequential drain proof.";
export const sequentialReplies = [
  "Deterministic long-task reply.",
  "Deterministic drain-one reply.",
  "Deterministic drain-two reply.",
];

export async function queuedSequential(seed: Seed) {
  const providerId = "sequential-queue-mock";
  const modelId = "sequential-queue-model";
  const modelName = "Sequential queue model";
  const requests: SequentialRequest[] = [];
  let releaseFirst: () => void = () => undefined;
  let releaseOne: () => void = () => undefined;
  const firstGate = new Promise<void>((resolveGate) => { releaseFirst = resolveGate; });
  const oneGate = new Promise<void>((resolveGate) => { releaseOne = resolveGate; });
  const classify = (rawBody: string): SequentialRequestLabel => {
    if (rawBody.includes(sequentialQueuedTwo)) return "two";
    if (rawBody.includes(sequentialQueuedOne)) return "one";
    if (rawBody.includes(sequentialFirstPrompt)) return "first";
    return "unexpected";
  };
  const provider = createServer((request, response) => {
    const url = request.url ?? "";
    if (request.method === "GET" && url.startsWith("/v1/models")) {
      sendJson(response, 200, { object: "list", data: [{ id: modelId, object: "model" }] });
      return;
    }
    if (request.method !== "POST" || (url !== "/v1/chat/completions" && url !== "/chat/completions")) {
      sendJson(response, 404, { error: { message: "not found" } });
      return;
    }
    void readBody(request).then((rawBody) => {
      let parsed: unknown;
      try { parsed = JSON.parse(rawBody); } catch { parsed = null; }
      const isMain = isRecord(parsed) && Array.isArray(parsed.tools) && parsed.tools.length > 0;
      const label = classify(rawBody);
      if (isMain) requests.push({ label, lastUserText: lastUserText(rawBody) });
      const reply = !isMain
        ? "Session title"
        : label === "first" ? sequentialReplies[0]
          : label === "one" ? sequentialReplies[1]
            : label === "two" ? sequentialReplies[2]
              : `Unexpected completion for: ${rawBody.slice(0, 200)}`;
      const id = `chatcmpl-sequential-queue-${requests.length}`;
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const write = (chunk: unknown): void => {
        if (!response.writableEnded) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      };
      write({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
      const finish = (): void => {
        write(completionChunk(id, reply, null));
        setTimeout(() => {
          write(completionChunk(id, "", "stop"));
          setTimeout(() => {
            if (!response.writableEnded) response.end("data: [DONE]\n\n");
          }, 300);
        }, 300);
      };
      if (isMain && label === "first") void firstGate.then(finish);
      else if (isMain && label === "one") void oneGate.then(finish);
      else setTimeout(finish, 400);
    });
  });
  const baseUrl = await listen(provider);
  try {
    const workspacePath = seed.tmpPath("sequential-queue");
    await writeProviderConfig(workspacePath, providerId, modelId, modelName, `${baseUrl}/v1`);
    const app = await seed.desktop({ name: "sequential-queue", model: `${providerId}/${modelId}` });
    const workspace = await seed.workspace(app, workspacePath);
    const session = await seedSessionRetry(seed, app);
    await selectModelInWorld(seed, app, modelName);
    return {
      app,
      workspace,
      session,
      requests,
      releaseFirst,
      releaseOne,
      async [Symbol.asyncDispose]() {
        releaseFirst();
        releaseOne();
        await close(provider);
      },
    };
  } catch (error) {
    releaseFirst();
    releaseOne();
    await close(provider);
    throw error;
  }
}

async function configureCrossWorkspaces(
  seed: Seed,
  app: Awaited<ReturnType<Seed["desktop"]>>,
  workspaceIds: string[],
  baseUrl: string,
): Promise<void> {
  // TODO(primitive): configure one provider across several workspaces and select its model.
  const configured = await seed.evalIn(app, browserScript(async (workspaceIdsJson, providerBaseUrl) => {
    const port = localStorage.getItem("openwork.server.port");
    const token = localStorage.getItem("openwork.server.token");
    if (!port || !token) return "missing local server credentials";
    const workspaceIds = JSON.parse(workspaceIdsJson);
    const root = "http://127.0.0.1:" + port;
    const headers = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
    for (const workspaceId of workspaceIds) {
      const patch = await fetch(root + "/workspace/" + encodeURIComponent(workspaceId) + "/config", {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          opencode: {
            permission: { bash: "allow" },
            provider: {
              "composer-switch-mock": {
                npm: "@ai-sdk/openai-compatible",
                name: "Composer switch model",
                options: { baseURL: providerBaseUrl, apiKey: "sk-composer-switch" },
                models: { "composer-switch-model": { name: "Composer switch model", tool_call: true } },
              },
            },
          },
        }),
      });
      if (!patch.ok) return "config:" + patch.status + ":" + (await patch.text()).slice(0, 300);
      const reload = await fetch(root + "/workspace/" + encodeURIComponent(workspaceId) + "/engine/reload", { method: "POST", headers });
      if (!reload.ok && reload.status !== 504) return "reload:" + reload.status + ":" + (await reload.text()).slice(0, 300);
    }
    const raw = localStorage.getItem("openwork.preferences");
    let preferences: Record<string, unknown> = {};
    try { preferences = raw ? JSON.parse(raw) : {}; } catch { preferences = {}; }
    if (!preferences || typeof preferences !== "object" || Array.isArray(preferences)) preferences = {};
    localStorage.setItem("openwork.preferences", JSON.stringify({
      ...preferences,
      defaultModel: { providerID: "composer-switch-mock", modelID: "composer-switch-model" },
      modelVariant: null,
      providerStepCompleted: true,
    }));
    localStorage.setItem("openwork.defaultModel", "composer-switch-mock/composer-switch-model");
    return "ok";
  }, [JSON.stringify(workspaceIds), `${baseUrl}/v1`]), { awaitPromise: true, timeoutMs: 180_000 });
  if (configured !== "ok") throw new Error(`Cross-workspace provider configuration failed: ${String(configured)}`);
  await seed.evalIn(app, () => { location.reload(); return true; });
}

export async function crossWorkspace(seed: Seed) {
  const runId = `${Date.now().toString(36)}-${process.pid}`;
  const sendMarker = `COMPOSER-SWITCH-SEND-${runId}`;
  const agent = seed.mock({
    agentWorkloads: [{
      promptMarker: sendMarker,
      finalReply: `DONE-${sendMarker}`,
      steps: [{
        tool: "bash",
        arguments: {
          command: `printf '%s\\n' 'ACK-${sendMarker}'`,
          timeout: 30_000,
          description: "Acknowledge the composer switch prompt",
        },
      }],
    }],
  });
  const den = await seed.den({
    mocks: { agent },
    org: {
      name: "Composer Switch",
      admin: { name: "Switch Admin" },
      members: { member: { name: "Switch Member" } },
    },
  });
  const app = await seed.desktop({ den, as: "member" });
  const workspaceB = await seed.workspace(app, seed.tmpPath(`composer-switch-${runId}-b`));
  const B1 = await seed.session(app);
  const B2 = await seed.session(app);
  await arrangeControl(seed, app, "session.rename", { sessionId: B1.sessionId, title: "Chat B1" });
  await arrangeControl(seed, app, "session.rename", { sessionId: B2.sessionId, title: "Chat B2" });
  const workspaceA = await seed.workspace(app, seed.tmpPath(`composer-switch-${runId}-a`));
  const A1 = await seed.session(app);
  const A2 = await seed.session(app);
  await arrangeControl(seed, app, "session.rename", { sessionId: A1.sessionId, title: "Chat A1" });
  await arrangeControl(seed, app, "session.rename", { sessionId: A2.sessionId, title: "Chat A2" });
  if (new Set([A1.sessionId, A2.sessionId, B1.sessionId, B2.sessionId]).size !== 4) {
    throw new Error("Four distinct cross-workspace sessions were not created.");
  }
  await configureCrossWorkspaces(seed, app, [workspaceA.workspaceId, workspaceB.workspaceId], den.mocks.agent.url);
  await selectModelInWorld(seed, app, "Composer switch model");
  return {
    app,
    sendMarker,
    chats: {
      A1: { ...A1, title: "Chat A1", workspaceId: workspaceA.workspaceId },
      A2: { ...A2, title: "Chat A2", workspaceId: workspaceA.workspaceId },
      B1: { ...B1, title: "Chat B1", workspaceId: workspaceB.workspaceId },
      B2: { ...B2, title: "Chat B2", workspaceId: workspaceB.workspaceId },
    },
  };
}

export async function markdownArtifact(seed: Seed) {
  const app = await seed.desktop({ name: "markdown-editor-autosave" });
  const workspace = await seed.workspace(app, seed.tmpPath("markdown-editor-autosave"));
  const session = await seedSessionRetry(seed, app);
  try {
    await arrangeControl(seed, app, "browser.open_url", { url: "about:blank" });
  } catch {
    // The browser can report ERR_ABORTED after it has already mounted the artifact side panel.
  }
  await arrangeControl(seed, app, "eval.artifact_tabs.seed_overflow", { count: 12 });
  return { app, workspace, session };
}

export async function mermaidChat(seed: Seed) {
  const app = await seed.desktop({ name: "mermaid-rendering" });
  const workspace = await seed.workspace(app, seed.tmpPath("mermaid-rendering"));
  const session = await seedSessionRetry(seed, app, { title: "Mermaid rendering proof" });
  await arrangeControl(seed, app, "eval.mermaid.set_theme", { mode: "light" });
  await arrangeControl(seed, app, "eval.markdown_primitive.seed_chat");
  return { app, workspace, session };
}

export const safeFirstPrompt = "First turn for safe edit proof.";
export const safeSecondPrompt = "Second turn that should be replaced.";
export const safeEditedPrompt = "Edited second turn that replaces the original.";
export const safeLegacyPrompt = "Legacy session restore proof.";
export const safeReplies = [
  "Deterministic first reply.",
  "Deterministic second reply.",
  "Deterministic edited reply.",
  "Deterministic legacy reply.",
];

export async function safeEdit(seed: Seed) {
  const providerId = "safe-edit-resend-mock";
  const modelId = "safe-edit-resend-model";
  let mainCompletionCount = 0;
  const provider = createServer((request, response) => {
    const url = request.url ?? "";
    if (request.method === "GET" && url.startsWith("/v1/models")) {
      sendJson(response, 200, { object: "list", data: [{ id: modelId, object: "model" }] });
      return;
    }
    if (request.method !== "POST" || (url !== "/v1/chat/completions" && url !== "/chat/completions")) {
      sendJson(response, 404, { error: { message: "not found" } });
      return;
    }
    void readBody(request).then((rawBody) => {
      let parsed: unknown;
      try { parsed = JSON.parse(rawBody); } catch { parsed = null; }
      const isMain = isRecord(parsed) && Array.isArray(parsed.tools) && parsed.tools.length > 0;
      const reply = !isMain
        ? "Session title"
        : rawBody.includes(safeEditedPrompt) ? safeReplies[2]
          : rawBody.includes(safeSecondPrompt) ? safeReplies[1]
            : rawBody.includes(safeLegacyPrompt) ? safeReplies[3]
              : rawBody.includes(safeFirstPrompt) ? safeReplies[0]
                : `Unexpected completion for: ${rawBody.slice(0, 200)}`;
      if (isMain) mainCompletionCount += 1;
      const id = `chatcmpl-safe-edit-${mainCompletionCount}`;
      const chunks = [
        { id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
        completionChunk(id, reply, null),
        completionChunk(id, "", "stop"),
      ];
      sendStream(response, chunks, 400);
    });
  });
  const baseUrl = await listen(provider);
  try {
    const app = await seed.desktop({ name: "safe-edit-resend", model: `${providerId}/${modelId}` });
    const workspace = await seed.workspace(app, seed.tmpPath("safe-edit-resend"));
    await configureProvider(seed, app, workspace.workspaceId, providerId, modelId, {
      provider: {
        [providerId]: {
          npm: "@ai-sdk/openai-compatible",
          name: "Safe edit resend mock",
          options: { baseURL: `${baseUrl}/v1`, apiKey: "sk-safe-edit-resend" },
          models: { [modelId]: { name: "Safe edit resend model" } },
        },
      },
    });
    const session = await seedSessionRetry(seed, app);
    return {
      app,
      workspace,
      session,
      mainCompletionCount: () => mainCompletionCount,
      async [Symbol.asyncDispose]() { await close(provider); },
    };
  } catch (error) {
    await close(provider);
    throw error;
  }
}

export async function sessionErrorCard(seed: Seed) {
  const app = await seed.desktop({ name: "session-error-technical-details" });
  const workspace = await seed.workspace(app, seed.tmpPath("session-error-details"));
  const session = await seedSessionRetry(seed, app, { title: "Session error proof" });
  await arrangeControl(seed, app, "eval.session_error.seed");
  return {
    app, workspace, session,
    seedStorageError: (kind: "disk-full" | "database-error", surface: "transcript" | "banner" = "transcript") => arrangeControl(seed, app, "eval.session_error.seed", { kind, surface }),
  };
}

export async function sessionSubmitErrorIsolation(seed: Seed) {
  const promptB = "Summarize the second task independently.";
  const replyB = "The second task completed independently.";
  const base = await splitPaneQuestions(seed, "session-submit-error-isolation", [
    { promptMarker: promptB, latestUserTurn: true, finalReply: replyB, steps: [] },
  ]);
  const sessionB = await seedSessionRetry(seed, base.app, { title: "Independent task B" });
  const sessionA = await seedSessionRetry(seed, base.app, { title: "Storage failure task A" });
  const endpoint = base.app.client.webSocketDebuggerUrl;
  if (!endpoint) throw new Error("Submit fault requires the desktop CDP endpoint");
  const origin = await evalIn(base.app, () => "http://127.0.0.1:" + localStorage.getItem("openwork.server.port"));
  const paths = (id: string) => ["workspace", "w"].flatMap(mount => ["opencode", "opencode2/api"].map(engine =>
    `/${mount}/${encodeURIComponent(base.workspace.workspaceId)}/${engine}/session/${encodeURIComponent(id)}/prompt_async`));
  const pathsA = paths(sessionA.sessionId);
  const pathsB = paths(sessionB.sessionId);
  const socket = new WebSocket(endpoint);
  const ready = Promise.withResolvers<void>();
  const commands = new Map<number, ReturnType<typeof Promise.withResolvers<void>>>();
  const held = new Map<string, string>();
  const finished = new Set<string>();
  const requests: { sessionId: string; body: string }[] = [];
  let nextId = 1;
  let disposed = false;
  let failure: Error | undefined;
  const command = async (method: string, params = {}) => {
    const id = nextId++;
    const result = Promise.withResolvers<void>();
    commands.set(id, result);
    const timer = setTimeout(() => result.reject(new Error(`Submit fault timed out: ${method}`)), 15_000);
    try { socket.send(JSON.stringify({ id, method, params })); await result.promise; }
    finally { clearTimeout(timer); commands.delete(id); }
  };
  const fail = (error = new Error("Submit fault lost its CDP connection")) => {
    if (disposed) return;
    failure = error;
    ready.reject(error);
    for (const result of commands.values()) result.reject(error);
  };
  socket.addEventListener("open", () => ready.resolve());
  socket.addEventListener("error", () => fail());
  socket.addEventListener("close", () => fail());
  socket.addEventListener("message", event => {
    const message: unknown = JSON.parse(String(event.data));
    if (!isRecord(message)) return;
    if (typeof message.id === "number") {
      const result = commands.get(message.id);
      if (message.error) result?.reject(new Error("Submit fault CDP command failed"));
      else result?.resolve();
    }
    const params = message.params;
    if (!isRecord(params) || typeof params.requestId !== "string") return;
    if (message.method === "Network.loadingFinished") finished.add(params.requestId);
    if (message.method !== "Fetch.requestPaused") return;
    const request = params.request;
    const path = isRecord(request) && typeof request.url === "string" ? new URL(request.url).pathname : "";
    if (isRecord(request) && request.method === "POST" && (pathsA.includes(path) || pathsB.includes(path))) {
      requests.push({ sessionId: pathsA.includes(path) ? sessionA.sessionId : sessionB.sessionId,
        body: typeof request.postData === "string" ? request.postData : "" });
      if (pathsA.includes(path)) {
        if (typeof params.networkId !== "string") { fail(new Error("Submit fault has no network request ID")); return; }
        held.set(params.requestId, params.networkId);
        return;
      }
    }
    void command("Fetch.continueRequest", { requestId: params.requestId }).catch(fail);
  });
  const timer = setTimeout(() => ready.reject(new Error("Submit fault could not connect")), 15_000);
  try {
    await ready.promise;
    await command("Network.enable");
    await command("Fetch.enable", { patterns: [...pathsA, ...pathsB].map(path => ({ urlPattern: origin + path + "*", requestStage: "Request" })) });
  } catch (error) { disposed = true; socket.close(); throw error; }
  finally { clearTimeout(timer); }
  return {
    ...base, sessionA, sessionB, promptB, replyB,
    readSubmissions() {
      if (failure) throw failure;
      return { requests: [...requests], held: held.size, finished: [...held.values()].filter(id => finished.has(id)).length };
    },
    async failHeldSubmissions() {
      if (failure) throw failure;
      const pending = [...held].filter(([, id]) => !finished.has(id));
      if (!pending.length) throw new Error("No submit request is held");
      // A real SDK response, not a seeded presentation: the storage code exists
      // only in the upstream response body, not in the top-level message.
      const body = Buffer.from(JSON.stringify({ name: "APIError", data: {
        message: "Connected service could not save the task output", statusCode: 507,
        responseBody: JSON.stringify({ error: { code: "EDQUOT", message: "Connected service storage quota exceeded" } }),
      } })).toString("base64");
      await Promise.all(pending.map(([requestId]) => command("Fetch.fulfillRequest", {
        requestId, responseCode: 507, responseHeaders: [
          { name: "content-type", value: "application/json" },
          { name: "access-control-allow-origin", value: "*" },
        ], body,
      })));
    },
    async selectedSurface() {
      return evalIn(base.app, () => {
        const surface = document.querySelector<HTMLElement>('[data-workbench-pane="primary"] [data-session-surface-id]');
        const run = surface?.querySelector<HTMLButtonElement>('button[aria-label="Run task"]');
        return { sessionId: surface?.dataset.sessionSurfaceId ?? "", runEnabled: Boolean(run && !run.disabled) };
      });
    },
    async settleResponse() {
      // Network completion precedes the SDK promise chain and React's commit.
      await evalIn(base.app, () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
        { awaitPromise: true, timeoutMs: 5_000 });
    },
    async [Symbol.asyncDispose]() {
      try { if (socket.readyState === WebSocket.OPEN) await command("Fetch.disable"); }
      finally { disposed = true; socket.close(); }
    },
  };
}

export async function snapshotFailure(seed: Seed) {
  const app = await seed.desktop({ name: "composer-snapshot-failure" });
  const workspace = await seed.workspace(app, seed.tmpPath("composer-snapshot-failure"));
  const session = await seedSessionRetry(seed, app, { title: "Composer snapshot failure proof" });
  await arrangeControl(seed, app, "eval.chat_transcript.seed");
  const failureJson = await seed.evalIn(app, browserScript(async () => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const available = window.__openworkControl?.listActions()
        .find((candidate) => candidate.id === "eval.session_snapshot.fail" && !candidate.disabled);
      if (available) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const result = await window.__openworkControl.execute("eval.session_snapshot.fail", null);
    if (!result?.ok) throw new Error(String(result?.error ?? "control action failed"));
    return JSON.stringify(result.result);
  }, []), { awaitPromise: true, timeoutMs: 120_000 });
  const failure: unknown = typeof failureJson === "string" ? JSON.parse(failureJson) : failureJson;
  if (!isRecord(failure) || failure.isError !== true) {
    throw new Error(`Session snapshot failure was not established: ${JSON.stringify(failure)}`);
  }
  return { app, workspace, session };
}

/** More stored messages than OpenCode's `limit`-paged transcript read used to fetch. */
export const longHistoryCount = 150;
export const longHistoryTitle = "Long conversation";
export const longHistoryOtherTitle = "Unrelated short task";
export const longHistoryFirst = "LONG-HISTORY-FIRST-MESSAGE 7c31";
export const longHistoryLast = "LONG-HISTORY-LAST-MESSAGE 7c31";

/** A long stored conversation opened cold, from another selected session. */
export async function longHistory(seed: Seed) {
  const app = await seed.desktop({ name: "session-full-history" });
  const workspace = await seed.workspace(app, seed.tmpPath("session-full-history"));
  const session = await seedSessionRetry(seed, app, { title: longHistoryTitle });
  // TODO(primitive): store many engine messages without a model turn.
  const seeded = await seed.evalIn(app, browserScript(async (workspaceId, sessionId, count, first, last) => {
    const port = localStorage.getItem("openwork.server.port");
    const token = localStorage.getItem("openwork.server.token");
    if (!port || !token) return "missing local server credentials";
    const base = "http://127.0.0.1:" + port + "/workspace/" + encodeURIComponent(workspaceId)
      + "/opencode/session/" + encodeURIComponent(sessionId) + "/message";
    const headers = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
    for (let index = 0; index < count; index += 1) {
      const text = index === 0 ? first : index === count - 1 ? last : "Stored history message " + (index + 1) + " of " + count + ".";
      const response = await fetch(base, {
        method: "POST",
        headers,
        body: JSON.stringify({ noReply: true, parts: [{ type: "text", text }] }),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) return "seed:" + index + ":" + response.status + ":" + (await response.text()).slice(0, 200);
    }
    const stored = await fetch(base, { headers, signal: AbortSignal.timeout(15000) });
    if (!stored.ok) return "stored:" + stored.status;
    const storedMessages = await stored.json();
    return Array.isArray(storedMessages) ? storedMessages.length : "stored:not-an-array";
  }, [workspace.workspaceId, session.sessionId, longHistoryCount, longHistoryFirst, longHistoryLast]), { awaitPromise: true, timeoutMs: 180_000 });
  if (seeded !== longHistoryCount) throw new Error(`Long history was not stored: ${String(seeded)}`);
  const other = await seedSessionRetry(seed, app, { title: longHistoryOtherTitle });
  return { app, workspace, session, other };
}

export async function taskActivity(seed: Seed) {
  const app = await seed.desktop({ name: "task-activity-shimmer" });
  const workspace = await seed.workspace(app, seed.tmpPath("task-activity-shimmer"));
  const session = await seedSessionRetry(seed, app);
  await arrangeControl(seed, app, "eval.task_activity.seed", { withFollowup: true });
  return { app, workspace, session };
}

async function stoppingFeedbackFault(
  seed: Seed,
  app: Surface,
  workspaceId: string,
  sessionId: string,
) {
  await seed.evalIn(app, browserScript((workspaceId, sessionId) => {
    if (window.__openworkStoppingFault) throw new Error("A Stop feedback fault is already active");
    const port = localStorage.getItem("openwork.server.port");
    if (!port) throw new Error("Stop feedback fault requires the local server port");
    const serverOrigin = `http://127.0.0.1:${port}`;
    const encodedWorkspaceId = encodeURIComponent(workspaceId);
    const encodedSessionId = encodeURIComponent(sessionId);
    const paths = new Set(["workspace", "w"].flatMap((mount) => [
      `/${mount}/${encodedWorkspaceId}/opencode/session/${encodedSessionId}/abort`,
      `/${mount}/${encodedWorkspaceId}/opencode2/api/session/${encodedSessionId}/interrupt`,
    ]));
    const originalFetch = window.fetch;
    let releaseHold = () => {};
    const hold = new Promise<void>((resolve) => { releaseHold = resolve; });
    const state = {
      attempts: 0,
      held: 0,
      nativeStatus: null as number | null,
      nativeFailed: false,
      released: false,
      failed: false,
      clickCaptured: false,
      trusted: false,
      elapsedMs: null as number | null,
      expired: false,
    };
    let clickedAt = 0;
    let frame = 0;
    let expiry: ReturnType<typeof setTimeout> | null = null;
    const sessionRoot = () => [...document.querySelectorAll<HTMLElement>("[data-session-surface-id]")]
      .find((candidate) => candidate.dataset.sessionSurfaceId === sessionId) ?? null;
    const visible = (element: HTMLElement | null) => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return element.getClientRects().length > 0 && rect.width > 0 && rect.height > 0
        && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0;
    };
    const sample = () => {
      if (!state.clickCaptured || state.elapsedMs !== null) return;
      const button = sessionRoot()?.querySelector<HTMLButtonElement>('button[aria-label="Stopping…"][aria-busy="true"]') ?? null;
      if (button?.disabled && visible(button)) state.elapsedMs = performance.now() - clickedAt;
    };
    const paint = () => { sample(); frame = requestAnimationFrame(paint); };
    const capture = (event: MouseEvent) => {
      if (state.clickCaptured || !event.isTrusted || !(event.target instanceof Element)) return;
      const button = event.target.closest<HTMLButtonElement>('button[aria-label="Stop"]');
      const root = sessionRoot();
      if (!button || !root?.contains(button)) return;
      state.clickCaptured = true;
      state.trusted = true;
      clickedAt = performance.now();
      expiry = setTimeout(() => { state.expired = true; }, 2_000);
      queueMicrotask(sample);
    };
    window.addEventListener("click", capture, true);
    const observer = new MutationObserver(sample);
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
    frame = requestAnimationFrame(paint);

    const wrappedFetch: typeof window.fetch = async (...args) => {
      const input = args[0];
      const init = args[1];
      const requestUrl = new URL(input instanceof Request ? input.url : String(input), location.href);
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      if (state.released || method !== "POST" || requestUrl.origin !== serverOrigin || !paths.has(requestUrl.pathname)) {
        return originalFetch(...args);
      }
      state.attempts += 1;
      state.held += 1;
      try {
        await hold;
        if (state.failed) {
          state.nativeStatus = 503;
          return new Response(JSON.stringify({ message: "Stop unavailable" }), {
            status: 503,
            statusText: "Service Unavailable",
            headers: { "content-type": "application/json" },
          });
        }
        try {
          const response = await originalFetch(...args);
          state.nativeStatus = response.status;
          return response;
        } catch (error) {
          state.nativeFailed = true;
          throw error;
        }
      } finally {
        state.held -= 1;
      }
    };
    window.fetch = wrappedFetch;
    const release = (failed: boolean) => {
      if (state.released) return;
      state.failed = failed;
      state.released = true;
      releaseHold();
    };
    const dispose = () => {
      release(true);
      if (window.fetch === wrappedFetch) window.fetch = originalFetch;
      if (expiry) clearTimeout(expiry);
      observer.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener("click", capture, true);
    };
    window.__openworkStoppingFault = { state, fail: () => release(true), dispose };
  }, [workspaceId, sessionId]));

  let disposed = false;
  return {
    async read() {
      return seed.evalIn(app, browserScript((sessionId) => {
        const fault = window.__openworkStoppingFault;
        if (!fault) throw new Error("Stop feedback fault lost its document");
        const root = [...document.querySelectorAll<HTMLElement>("[data-session-surface-id]")]
          .find((candidate) => candidate.dataset.sessionSurfaceId === sessionId) ?? null;
        const stopping = root?.querySelector<HTMLButtonElement>('button[aria-label="Stopping…"]') ?? null;
        const retry = root?.querySelector<HTMLButtonElement>('button[aria-label="Stop"]') ?? null;
        const run = root?.querySelector<HTMLButtonElement>('button[aria-label="Run task"]') ?? null;
        const error = root?.querySelector<HTMLElement>('[data-testid="session-error-card"]') ?? null;
        const aggregate = root?.querySelector<HTMLElement>("[data-tool-aggregate]") ?? null;
        const composer: unknown = window.__openwork?.slice("composer");
        const snapshotQuery = composer && typeof composer === "object" && "snapshotQuery" in composer
          ? composer.snapshotQuery
          : null;
        const visible = (element: HTMLElement | null) => {
          if (!element) return false;
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return element.getClientRects().length > 0 && rect.width > 0 && rect.height > 0
            && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0;
        };
        return {
          ...fault.state,
          stoppingVisible: visible(stopping),
          stoppingDisabled: stopping?.disabled ?? false,
          ariaBusy: stopping?.getAttribute("aria-busy") ?? null,
          spinnerVisible: visible(stopping?.querySelector<HTMLElement>("svg.lucide-loader-circle.animate-spin") ?? null),
          retryEnabled: Boolean(retry && visible(retry) && !retry.disabled),
          runVisible: visible(run),
          errorText: error?.innerText.replace(/\s+/g, " ").trim() ?? "",
          aggregateText: aggregate?.innerText.replace(/\s+/g, " ").trim() ?? "",
          snapshotMessageCount: snapshotQuery && typeof snapshotQuery === "object" && "dataMessageCount" in snapshotQuery
            && typeof snapshotQuery.dataMessageCount === "number" ? snapshotQuery.dataMessageCount : 0,
          surfaceError: composer && typeof composer === "object" && "error" in composer ? composer.error : null,
        };
      }, [sessionId]));
    },
    async fail() {
      await seed.evalIn(app, () => {
        const fault = window.__openworkStoppingFault;
        if (!fault || fault.state.held < 1) throw new Error("No native Stop response is held");
        fault.fail();
      });
    },
    async [Symbol.asyncDispose]() {
      if (disposed) return;
      disposed = true;
      await seed.evalIn(app, () => {
        window.__openworkStoppingFault?.dispose();
        delete window.__openworkStoppingFault;
      });
    },
  };
}

export async function unfinishedToolsWeb(seed: Seed) {
  const engine = resolveEvalEngine();
  const prompt = "Hold the native tool open for Stop feedback proof.";
  const warmup = { prompt: "Create the Stop feedback fixture.", reply: "Stop feedback fixture ready." };
  const base = await splitPaneQuestions(seed, "unfinished-tool-lifecycle", [
    { promptMarker: warmup.prompt, latestUserTurn: true, finalReply: warmup.reply, steps: [] },
    {
      promptMarker: prompt,
      latestUserTurn: true,
      finalReply: "The held tool finished without Stop.",
      steps: [{ tool: engine === "v2" ? "shell" : "bash", arguments: {
        command: "sleep 120",
        description: "Hold the native tool for Stop feedback",
        timeout: 180_000,
      } }],
    },
  ], { permission: { bash: "allow" } }, "web");
  const session = await seedSessionRetry(seed, base.app);
  // v2 exposes live runs through /session/active ({ type: "running" }) rather than /session/status.
  const statusPath = `/workspace/${encodeURIComponent(base.workspace.workspaceId)}`
    + `/${engine === "v2" ? "opencode2/api/session/active" : "opencode/session/status"}`;
  return {
    ...base,
    session,
    prompt,
    warmup,
    engine,
    startStopFault: () => stoppingFeedbackFault(seed, base.app, base.workspace.workspaceId, session.sessionId),
    nativeStatus: () => seed.evalIn(base.app, browserScript(async (statusPath, sessionId) => {
      const port = localStorage.getItem("openwork.server.port");
      const token = localStorage.getItem("openwork.server.token");
      const response = await fetch(`http://127.0.0.1:${port}${statusPath}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) return `http-${response.status}`;
      const payload: unknown = await response.json();
      // v2 wraps its body in { data }; v1 answers with the bare status map.
      const statuses: unknown = payload && typeof payload === "object" && "data" in payload ? payload.data : payload;
      if (!statuses || typeof statuses !== "object") return "missing";
      // The engine only lists sessions with live work; an absent session is idle.
      if (!(sessionId in statuses)) return "idle";
      const status: unknown = Object.entries(statuses).find(([id]) => id === sessionId)?.[1];
      if (!status || typeof status !== "object" || !("type" in status) || typeof status.type !== "string") return "invalid";
      return status.type === "running" ? "busy" : status.type;
    }, [statusPath, session.sessionId]), { awaitPromise: true }),
  };
}

/** Signed-in chat with a deterministic model and a scheduled desktop task. */
export async function computerMentions(seed: Seed) {
  const providerId = "computer-mentions-mock";
  const modelId = "computer-mentions-model";
  const mock = seed.mock({
    allowUnauthenticatedMcp: true,
    tools: [
      {
        name: "search_capabilities",
        description: "Find a computer task capability.",
        inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        result: { content: [{ type: "text", text: JSON.stringify({ items: [{ name: "remote-session:create" }] }) }] },
      },
      {
        name: "execute_capability",
        description: "Start a task on the selected computer.",
        inputSchema: { type: "object", properties: { name: { type: "string" }, body: { type: "object", properties: { target: { type: "string", enum: ["cloud", "desktop"] }, prompt: { type: "string" } }, required: ["target", "prompt"] } }, required: ["name", "body"] },
        result: { content: [{ type: "text", text: JSON.stringify({ state: "queued", commandId: "computer-task-witness" }) }] },
      },
    ],
    agentWorkloads: [
      ...["cloud", "desktop"].map((target): MockAgentWorkload => ({
        // Only the app's synthetic instruction contains this marker. Without routing, the model refuses the task.
        promptMarker: `[The user selected @${target}:`,
        finalReply: "Received computer task.",
        steps: [
          { tool: "computer_witness_search_capabilities", arguments: { query: "remote-session:create" } },
          { tool: "computer_witness_execute_capability", arguments: {}, argumentsFrom: "computer-mention" },
        ],
      })),
      { promptMarker: "COMPUTER-PLAIN-TASK", finalReply: "Received computer task.", steps: [] },
    ],
  });
  const den = await seed.den({ mocks: { agent: mock }, env: { DEN_AUTOMATIONS_ENABLED: "true" } });
  const created = await seed.api(den.admin, "/v1/automations", {
    method: "POST",
    body: JSON.stringify({
      name: "Daily project summary",
      instructions: "Summarize today's project notes.",
      schedule: { kind: "daily", timezone: "UTC", hour: 23, minute: 59 },
      model: { providerId: "opencode", modelId: "big-pickle", variant: null },
    }),
  });
  if (created.response.status !== 201) throw new Error(`Automation setup failed: ${created.text}`);
  const app = await seed.desktop({ den, as: "admin", model: `${providerId}/${modelId}` });
  const workspace = await seed.workspace(app, seed.tmpPath("computer-mentions"));
  await configureProvider(seed, app, workspace.workspaceId, providerId, modelId, {
    permission: { "computer_witness_*": "allow" },
    mcp: { computer_witness: { type: "remote", url: den.mocks.agent.mcpUrl, enabled: true, oauth: false } },
    provider: {
      [providerId]: {
        npm: "@ai-sdk/openai-compatible",
        name: "Computer mentions mock",
        options: { baseURL: `${den.mocks.agent.url}/v1`, apiKey: "sk-computer-mentions" },
        models: { [modelId]: { name: "Computer mentions model" } },
      },
    },
  });
  const session = await seedSessionRetry(seed, app, { title: "Computer task mentions" });
  return {
    den, app, workspace, session,
    async submittedParts() {
      // TODO(primitive): inspect submitted engine parts, including synthetic routing instructions.
      return seed.evalIn(app, browserScript(async (workspaceId) => {
        const port = localStorage.getItem("openwork.server.port");
        const token = localStorage.getItem("openwork.server.token");
        const base = "http://127.0.0.1:" + port + "/workspace/" + encodeURIComponent(workspaceId) + "/opencode/session";
        const headers = { Authorization: "Bearer " + token };
        const listed = await fetch(base, { headers });
        if (!listed.ok) throw new Error("Session list failed: " + listed.status);
        const sessions = await listed.json();
        const messages = [];
        for (const session of sessions) {
          const response = await fetch(base + "/" + encodeURIComponent(session.id) + "/message", { headers });
          if (!response.ok) throw new Error("Transcript read failed: " + response.status);
          messages.push(...await response.json());
        }
        messages.sort((a, b) => a.info.time.created - b.info.time.created);
        return messages.filter((message) => message.info.role === "user").map((message) => ({
          visible: message.parts.filter((part: { type: string; synthetic?: boolean; text: string }) => part.type === "text" && !part.synthetic).map((part: { text: string }) => part.text).join("").trim(),
          routing: message.parts.filter((part: { type: string; synthetic?: boolean; text: string }) => part.type === "text" && part.synthetic).map((part: { text: string }) => part.text),
        }));
      }, [workspace.workspaceId]), { awaitPromise: true });
    },
  };
}

/** A deterministic model calls the real built-in visualization tool. */
export async function visualization(seed: Seed) {
  const providerId = "visualization-mock";
  const modelId = "visualization-model";
  const design = {
    id: "project-overview", title: "Project overview", revision: 1,
    navigation: ["Overview", "Projects", "Settings"],
    sections: [{ title: "Your workspace", columns: "two", blocks: [
      { kind: "metric", label: "Active projects", value: "12" },
      { kind: "field", label: "Project name", value: "Website refresh" },
      { kind: "button", label: "Create project" },
      { kind: "list", label: "Recent activity", items: ["Draft reviewed", "Mockup updated"] },
      { kind: "image", label: "Cover image" },
      { kind: "text", label: "Design note", value: "<script>window.mockupExecuted = true</script>" },
    ] }],
  };
  const mock = seed.mock({ agentWorkloads: [
    { latestUserTurn: true, promptMarker: "Sketch a project overview", finalReply: "Your first sketch is ready.", steps: [{ tool: "openwork_visualization", arguments: design }] },
    { latestUserTurn: true, promptMarker: "Create version 2", finalReply: "Your revised sketch is ready.", steps: [{ tool: "openwork_visualization", arguments: { ...design, revision: 2, description: "A calmer overview" } }] },
  ] });
  const den = await seed.den({ mocks: { agent: mock } });
  const app = await seed.desktop({ name: "visualization", model: `${providerId}/${modelId}` });
  const workspace = await seed.workspace(app, seed.tmpPath("visualization"));
  await configureProvider(seed, app, workspace.workspaceId, providerId, modelId, {
    permission: { openwork_visualization: "allow" },
    provider: { [providerId]: {
      npm: "@ai-sdk/openai-compatible", name: "Visualization mock",
      options: { baseURL: `${den.mocks.agent.url}/v1`, apiKey: "sk-visualization" },
      models: { [modelId]: { name: "Visualization model", tool_call: true } },
    } },
  });
  const session = await seedSessionRetry(seed, app);
  return {
    den, app, workspace, session,
    preview: async () => {
      const result = await evalIn(app, () => {
      const preview = document.querySelector<HTMLElement>('[data-testid="visualization-preview"]');
      return { viewport: preview?.getAttribute('data-viewport'), width: preview?.getBoundingClientRect().width,
        scripts: preview?.querySelectorAll('script').length, executed: window.mockupExecuted === true,
        cards: document.querySelectorAll<HTMLElement>('[data-testid="visualization-card"]').length };
    });
      if (!isRecord(result) || typeof result.width !== "number") throw new Error("Visualization preview missing");
      return { ...result, width: result.width };
    },
  };
}


/** A persisted workspace and conversation created before opting into the other engine. */
export async function workspaceEngineUpgrade(seed: Seed) {
  const providerId = "workspace-upgrade-mock";
  const modelId = "workspace-upgrade-model";
  const mock = seed.mock({ agentWorkloads: [{
    promptMarker: "hi",
    finalReply: "Hello. Your upgrade conversation is working.",
    finalReplyChunkSize: 3,
    finalReplyDelayMs: 750,
    steps: [],
  }] });
  const den = await seed.den({ mocks: { agent: mock } });
  const primaryPath = seed.tmpPath("upgrade-primary");
  const otherPath = seed.tmpPath("upgrade-existing");
  const app = await seed.desktop({ den, as: "admin", workspacePath: primaryPath, model: `${providerId}/${modelId}` });
  const primary = await seed.workspace(app, primaryPath);
  const provider = { provider: { [providerId]: {
    npm: "@ai-sdk/openai-compatible", name: "Upgrade mock",
    options: { baseURL: `${den.mocks.agent.url}/v1`, apiKey: "sk-upgrade-fixture" },
    models: { [modelId]: { name: "Upgrade model" } },
  } } };
  await configureProvider(seed, app, primary.workspaceId, providerId, modelId, provider);
  const original = await seedSessionRetry(seed, app, { title: "Before engine upgrade" });
  const other = await seed.workspace(app, otherPath, { create: true });
  await configureProvider(seed, app, other.workspaceId, providerId, modelId, provider);
  const otherOriginal = await seedSessionRetry(seed, app, { title: "Existing workspace history" });
  return { app, den, primary, other, original, otherOriginal, providerId, modelId,
    otherName: otherPath.split("/").at(-1),
  };
}

/** A running conversation whose workspace skills can change through OpenWork. */
export async function skillLifecycle(seed: Seed) {
  const live = liveOpenAiEnabled();
  const orgName = "Skill lifecycle";
  const den = await seed.den({ org: { name: orgName }, mocks: { model: seed.mock({}) } });
  const managed = await provisionLiveOpenAi(den.admin, orgName);
  try {
    const app = await seed.desktop({ den, as: "admin" });
    const workspace = await seed.workspace(app, seed.tmpPath("skill-lifecycle"));
    const request = async (path: string) => {
      const response = await seed.evalIn(app, browserScript(async (path) => {
        const response = await fetch("http://127.0.0.1:" + localStorage.getItem("openwork.server.port") + path, {
          headers: { Authorization: "Bearer " + localStorage.getItem("openwork.server.token") },
          signal: AbortSignal.timeout(10000),
        });
        return { status: response.status, json: await response.json() };
      }, [path]), { awaitPromise: true });
      if (!isRecord(response) || typeof response.status !== "number") throw new Error("Missing desktop response");
      assertNoLiveSecret(response);
      return { status: response.status, json: response.json };
    };
    const providerId = live ? await liveProviderId(request, managed.id) : "skill-lifecycle";
    const modelId = live ? liveOpenAiModel() : "skill-lifecycle-model";
    // This world arranges an opted-in native v2 conversation, including when
    // invoked by the standard E2E command without an engine override.
    await seed.evalIn(app, async () => {
      const response = await fetch("http://127.0.0.1:" + localStorage.getItem("openwork.server.port") + "/experimental/engine-v2-preview", {
        method: "PUT", headers: { Authorization: "Bearer " + localStorage.getItem("openwork.server.token"), "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true, chatRouting: true }), signal: AbortSignal.timeout(180000),
      });
      if (!response.ok) throw new Error("Could not enable the native engine");
      return true;
    }, { awaitPromise: true, timeoutMs: 185_000 });
    await configureProvider(seed, app, workspace.workspaceId, providerId, modelId, {
      permission: { skill: "allow" },
      ...(!live ? { provider: { [providerId]: {
        npm: "@ai-sdk/openai-compatible", name: "Skill lifecycle model",
        options: { baseURL: `${den.mocks.model.url}/v1`, apiKey: "eval-only-key" },
        models: { [modelId]: { name: "Skill lifecycle model", tool_call: true } },
      } } } : {}),
    }, "v2");
    const session = await seedSessionRetry(seed, app, { title: "Release report" });
    const skillName = "release-briefing";
    return {
      app, den, workspace, session, skillName, live, modelId,
      async prepareTurn(prompt: string) {
        if (live) return;
        const result = await fetch(`${den.mocks.model.url}/admin/agent-workloads`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ workloads: [{ latestUserTurn: true, promptMarker: prompt,
            finalReply: "OpenWork: UNAVAILABLE", finalReplyFrom: "last-tool-text",
            steps: [{ tool: "skill", argumentsFrom: "skill-catalog", arguments: { skill: skillName } }],
          }] }),
        });
        if (!result.ok) throw new Error("Could not arrange model response");
      },
      async usedConfiguredModel() {
        const result = await request(`/workspace/${workspace.workspaceId}/opencode2/api/session/${session.sessionId}/message`);
        const messages = isRecord(result.json) && Array.isArray(result.json.data) ? result.json.data.filter(isRecord) : [];
        const replies = messages.filter(message => message.type === "assistant" && message.finish === "stop");
        return replies.length > 0 && replies.every(message => isRecord(message.model)
          && message.model.id === modelId && message.model.providerID === providerId
          && isRecord(message.tokens) && typeof message.tokens.output === "number" && message.tokens.output > 0);
      },
      async runtimeIdentity() {
        const result = await request("/experimental/engine-v2-preview/status");
        if (!isRecord(result.json) || result.json.running !== true || result.json.chatRouting !== true
          || typeof result.json.pid !== "number") throw new Error("The v2 conversation runtime is not running");
        return result.json.pid;
      },
      async [Symbol.asyncDispose]() { await managed[Symbol.asyncDispose](); },
    };
  } catch (error) {
    await managed[Symbol.asyncDispose]();
    throw error;
  }
}
