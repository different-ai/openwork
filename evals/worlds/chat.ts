import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { evalIn } from "@openwork/behaviors";
import { resolveEvalEngine, type Seed } from "@openwork/env";
import type { MockAgentWorkload } from "@openwork/labs";

const repoRoot = resolve(import.meta.dirname, "../..");

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
  app: Awaited<ReturnType<Seed["desktop"]>>,
  workspaceId: string,
  providerId: string,
  modelId: string,
  opencode: Record<string, unknown>,
): Promise<void> {
  // TODO(primitive): configure a workspace provider and select its model.
  const result = await seed.evalIn(app, `async (workspaceId, providerId, modelId, defaultModel, opencodeJson) => {
    const port = localStorage.getItem("openwork.server.port");
    const token = localStorage.getItem("openwork.server.token");
    if (!port || !token) return "missing local server credentials";
    const opencode = JSON.parse(opencodeJson);
    const request = async (path, init) => {
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
    let preferences = {};
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
  }`, {
    args: [workspaceId, providerId, modelId, `${providerId}/${modelId}`, JSON.stringify(opencode)],
    awaitPromise: true,
    timeoutMs: 120_000,
  });
  if (result !== "ok") throw new Error(`Provider configuration failed: ${String(result)}`);
  await seed.evalIn(app, "location.reload(); true");
  const ready = await seed.evalIn(app, `async (workspaceId) => {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const port = localStorage.getItem("openwork.server.port");
      const token = localStorage.getItem("openwork.server.token");
      try {
        const response = await fetch("http://127.0.0.1:" + port + "/workspace/" + encodeURIComponent(workspaceId) + "/opencode/session", {
          headers: { Authorization: "Bearer " + token },
        });
        if (response.ok && window.__openworkControl) return true;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return false;
  }`, { args: [workspaceId], awaitPromise: true, timeoutMs: 120_000 });
  if (ready !== true) throw new Error("Engine did not become ready after provider configuration.");
}

async function seedControls(
  seed: Seed,
  app: Awaited<ReturnType<Seed["desktop"]>>,
  calls: readonly { action: string; args?: unknown }[],
): Promise<void> {
  for (const call of calls) await arrangeControl(seed, app, call.action, call.args);
}

export async function arrangeControl(
  seed: Seed,
  app: Awaited<ReturnType<Seed["desktop"]>>,
  action: string,
  args?: unknown,
): Promise<unknown> {
  // TODO(primitive): invoke a named renderer fixture control and await its result.
  return seed.evalIn(app, `async (action, argsJson) => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const available = window.__openworkControl?.listActions().find((candidate) => candidate.id === action && !candidate.disabled);
      if (available) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const result = await window.__openworkControl.execute(action, JSON.parse(argsJson));
    if (!result?.ok) throw new Error(String(result?.error ?? "control action failed"));
    return result.value;
  }`, { args: [action, JSON.stringify(args ?? null)], awaitPromise: true, timeoutMs: 120_000 });
}

async function seedSessionRetry(
  seed: Seed,
  app: Awaited<ReturnType<Seed["desktop"]>>,
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

export async function newSplitPrimary(seed: Seed) {
  const providerId = "split-send-mock";
  const modelId = "split-send-model";
  const primaryPrompt = "Reply to the primary split message";
  const secondaryPrompt = "Reply to the secondary split message";
  const switchPrompt = "Reply after switching the primary session";
  const mock = seed.mock({ agentWorkloads: [
    { promptMarker: primaryPrompt, finalReply: "Primary split received", steps: [] },
    { promptMarker: secondaryPrompt, finalReply: "Secondary split received", steps: [] },
    { promptMarker: switchPrompt, finalReply: "Switched session received", steps: [] },
  ] });
  const den = await seed.den({ mocks: { agent: mock } });
  const app = await seed.desktop({ name: "new-split-session", den, as: "admin", model: `${providerId}/${modelId}` });
  const workspace = await seed.workspace(app, seed.tmpPath("new-split-session"));
  await configureProvider(seed, app, workspace.workspaceId, providerId, modelId, {
    provider: {
      [providerId]: {
        npm: "@ai-sdk/openai-compatible",
        name: "Split send mock",
        options: { baseURL: `${den.mocks.agent.url}/v1`, apiKey: "sk-split-send" },
        models: { [modelId]: { name: "Split send model" } },
      },
    },
  });
  const switchSession = await seedSessionRetry(seed, app, { title: "Split switch target" });
  const session = await seedSessionRetry(seed, app, { title: "New split primary" });
  const splitFacts = () => evalIn(app, `(() => {
    const context = window.__openworkControl?.context?.();
    const layout = context?.conversations?.layout;
    const primaryPane = document.querySelector('[data-workbench-pane="primary"]');
    const secondaryPanes = [...document.querySelectorAll('[data-workbench-pane="secondary"]')];
    const secondaryPane = secondaryPanes[0];
    return {
      layoutKind: layout?.kind ?? "",
      focusedPane: layout?.focused ?? "",
      focusedComposerSessionId: document.activeElement?.matches('[contenteditable="true"]')
        ? document.activeElement.closest("[data-session-surface-id]")?.getAttribute("data-session-surface-id") ?? ""
        : "",
      primarySessionId: layout?.primarySessionId ?? layout?.sessionId ?? "",
      secondarySessionId: layout?.secondarySessionId ?? "",
      primaryWorkspaceId: layout?.primaryWorkspaceId ?? "",
      secondaryWorkspaceId: layout?.secondaryWorkspaceId ?? "",
      primarySurfaceSessionId: primaryPane?.querySelector('[data-session-surface-id]')
        ?.getAttribute('data-session-surface-id') ?? "",
      secondarySurfaceSessionId: secondaryPane?.querySelector('[data-session-surface-id]')
        ?.getAttribute('data-session-surface-id') ?? "",
      secondaryPaneWorkspaceId: secondaryPane?.getAttribute('data-workbench-workspace-id') ?? "",
      secondaryPaneCount: secondaryPanes.length,
      locationHash: window.location.hash,
    };
  })()`);
  const agentContextViaServer = () => evalIn(app, `(async () => {
    const response = await fetch("http://127.0.0.1:" + localStorage.getItem("openwork.server.port") + "/experimental/ui-control/request", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + localStorage.getItem("openwork.server.token"),
        "content-type": "application/json",
      },
      body: JSON.stringify({ kind: "context" }),
    });
    return response.json();
  })()`, { awaitPromise: true, timeoutMs: 15_000 });
  return { app, workspace, session, splitFacts, agentContextViaServer, primaryPrompt, secondaryPrompt, switchSession, switchPrompt };
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
  const opened = await seed.evalIn(app, `(() => {
    const trigger = document.querySelector('button[title="Agents, commands, skills, plugins, and connections"]');
    if (!(trigger instanceof HTMLButtonElement)) return false;
    trigger.click();
    return true;
  })()`);
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
  const child = spawn("bun", ["--conditions=development", "-e", script], {
    cwd: join(repoRoot, "apps", "server"),
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
    await seed.evalIn(app, `(() => {
      localStorage.setItem("openwork.debug.profiler", "1");
      localStorage.removeItem("openwork.debug.profilerOverlay");
      location.reload();
      return true;
    })()`);
    const controlsReady = await seed.evalIn(app, `(async () => {
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        if (window.__openworkControl?.listActions().some((action) => action.id === "session.create_task" && !action.disabled)) return true;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return false;
    })()`, { awaitPromise: true, timeoutMs: 120_000 });
    if (controlsReady !== true) throw new Error("Session controls did not return after enabling the profiler.");
    const session = await seedSessionRetry(seed, app);
    await seed.composerText(app, `Reply with exactly: ${renderCycleFirstReply}`);
    // TODO(primitive): send an arranged historical turn and await its completion.
    const historical = await seed.evalIn(app, `async (expectedReply) => {
      const sent = await window.__openworkControl.execute("composer.send", null);
      if (!sent?.ok) throw new Error(String(sent?.error ?? "composer.send failed"));
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        if (document.body.innerText.includes(expectedReply)) return true;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return false;
    }`, { args: [renderCycleFirstReply], awaitPromise: true, timeoutMs: 120_000 });
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

export const streamedMarkdownMarker = "STREAM_MARKDOWN_ANSWER";
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
      finalReplyChunkSize: 8,
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
        models: { [modelId]: { name: "Streamed markdown model" } },
      },
    },
  });
  // A tiny H.264 clip, served through the same authenticated file endpoint as user files.
  await seed.evalIn(app, `async (workspaceId, dataBase64) => {
    const base = "http://127.0.0.1:" + localStorage.getItem("openwork.server.port");
    const response = await fetch(base + "/workspace/" + encodeURIComponent(workspaceId) + "/files/raw", {
      method: "POST",
      headers: { Authorization: "Bearer " + localStorage.getItem("openwork.server.token"), "Content-Type": "application/json" },
      body: JSON.stringify({ path: "clip.mp4", dataBase64 }),
    });
    if (!response.ok) throw new Error("Video fixture write failed: " + response.status);
  }`, { args: [workspace.workspaceId, (await readFile(new URL("../fixtures/assistant-video.mp4", import.meta.url))).toString("base64")], awaitPromise: true });
  const engine = resolveEvalEngine();
  const ready = await seed.evalIn(app, `async (workspaceId, engine, providerId, modelId) => {
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
  }`, { args: [workspace.workspaceId, engine, providerId, modelId], awaitPromise: true, timeoutMs: 65000 });
  if (ready !== true) throw new Error(`Selected ${engine} engine was not ready for the streaming journey`);
  const session = await seedSessionRetry(seed, app);
  return { app, den, workspace, session,
    async videoState(play = false) {
      return seed.evalIn(app, `async (play) => {
        const video = document.querySelector('video[data-openwork-video-path="clip.mp4"]');
        if (!video) return null;
        if (play) await video.play();
        return { controls: video.controls, autoplay: video.autoplay, ready: video.readyState >= 2,
          paused: video.paused, time: video.currentTime, error: video.error?.message ?? null };
      }`, { args: [play], awaitPromise: true });
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
  const selected = await seed.evalIn(app, `async (modelName) => {
    const deadline = Date.now() + 60000;
    if (!document.querySelector('input[placeholder="Search providers and models..."]')) {
      const result = await window.__openworkControl.execute("session.model_picker.open", null);
      if (!result?.ok) return false;
    }
    while (Date.now() < deadline) {
      const input = document.querySelector('input[placeholder="Search providers and models..."]');
      if (input instanceof HTMLInputElement && input.value !== modelName) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        setter?.call(input, modelName);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      const dialog = document.querySelector('[data-slot="dialog-content"]');
      const item = [...(dialog?.querySelectorAll("button") ?? [])]
        .find((candidate) => !candidate.disabled && (candidate.textContent ?? "").includes(modelName));
      if (item instanceof HTMLElement) {
        item.click();
        while (Date.now() < deadline) {
          if (!document.querySelector('input[placeholder="Search providers and models..."]')) return true;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  }`, { args: [modelName], awaitPromise: true, timeoutMs: 120_000 });
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
  const configured = await seed.evalIn(app, `async (workspaceIdsJson, providerBaseUrl) => {
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
    let preferences = {};
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
  }`, { args: [JSON.stringify(workspaceIds), `${baseUrl}/v1`], awaitPromise: true, timeoutMs: 180_000 });
  if (configured !== "ok") throw new Error(`Cross-workspace provider configuration failed: ${String(configured)}`);
  await seed.evalIn(app, "location.reload(); true");
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

export async function snapshotFailure(seed: Seed) {
  const app = await seed.desktop({ name: "composer-snapshot-failure" });
  const workspace = await seed.workspace(app, seed.tmpPath("composer-snapshot-failure"));
  const session = await seedSessionRetry(seed, app, { title: "Composer snapshot failure proof" });
  await arrangeControl(seed, app, "eval.chat_transcript.seed");
  const failureJson = await seed.evalIn(app, `async () => {
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
  }`, { args: [], awaitPromise: true, timeoutMs: 120_000 });
  const failure: unknown = typeof failureJson === "string" ? JSON.parse(failureJson) : failureJson;
  if (!isRecord(failure) || failure.isError !== true) {
    throw new Error(`Session snapshot failure was not established: ${JSON.stringify(failure)}`);
  }
  return { app, workspace, session };
}

export async function taskActivity(seed: Seed) {
  const app = await seed.desktop({ name: "task-activity-shimmer" });
  const workspace = await seed.workspace(app, seed.tmpPath("task-activity-shimmer"));
  const session = await seedSessionRetry(seed, app);
  await arrangeControl(seed, app, "eval.task_activity.seed");
  return { app, workspace, session };
}

export async function unfinishedTools(seed: Seed) {
  const app = await seed.desktop({ name: "unfinished-tool-lifecycle" });
  const workspace = await seed.workspace(app, seed.tmpPath("unfinished-tool-lifecycle"));
  const session = await seedSessionRetry(seed, app);
  await arrangeControl(seed, app, "eval.session_lifecycle.seed_unfinished_tools", { lifecycle: "active" });
  return { app, workspace, session };
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
      return seed.evalIn(app, `async (workspaceId) => {
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
          visible: message.parts.filter((part) => part.type === "text" && !part.synthetic).map((part) => part.text).join("").trim(),
          routing: message.parts.filter((part) => part.type === "text" && part.synthetic && part.text.includes("remote-session:create")).map((part) => part.text),
        }));
      }`, { args: [workspace.workspaceId], awaitPromise: true });
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
      const result = await evalIn(app, `(() => {
      const preview = document.querySelector('[data-testid="visualization-preview"]');
      return { viewport: preview?.getAttribute('data-viewport'), width: preview?.getBoundingClientRect().width,
        scripts: preview?.querySelectorAll('script').length, executed: window.mockupExecuted === true,
        cards: document.querySelectorAll('[data-testid="visualization-card"]').length };
    })()`);
      if (!isRecord(result) || typeof result.width !== "number") throw new Error("Visualization preview missing");
      return { ...result, width: result.width };
    },
  };
}
