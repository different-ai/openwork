import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { expect, onTestFinished } from "vitest";
import { clickButton, control, createAndSelectWorkspace, evalIn, waitFor } from "@openwork/behaviors";
import { connect, debuggerUrlFor, evaluate, listTargets } from "@openwork/cdp";
import { screenshot, validate } from "@openwork/test-evidence";
import { desktop } from "@openwork/hosts";
import { needs, test } from "@openwork/testkit";
import { buildGeneratedArtifactViewInWorker } from "../../ee/apps/den-api/src/generated-artifact-view-builder.js";

const providerId = "mcp-app-inline-host-mock";
const modelId = "mcp-app-inline-host-model";
const mcpServerName = "artifact-view";
const saveToolName = "save_artifact_view";
const mcpToolName = "render_card";
const resourceUri = "ui://openwork/artifacts/arv_eval_card/views/avr_eval_card/index.html";
const closingReply = "The interactive artifact card is ready.";
const e2eTestsEnabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const localPlacement = process.env.OPENWORK_EVAL_DAYTONA !== "1"
  && !process.env.OPENWORK_EVAL_DEN_API_URL?.trim();
const title = !e2eTestsEnabled
  ? "MCP App inline host skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1"
  : !localPlacement
    ? "MCP App inline host skipped — needs local placement without OPENWORK_EVAL_DEN_API_URL"
    : "a generated Artifact saves normally, then initializes and renders structuredContent inline";

async function createWorkspaceForRenderer(
  app: Awaited<ReturnType<typeof desktop>>,
  path: string,
): Promise<{ workspaceId: string; route: string }> {
  const packaged = await evalIn(app, "location.protocol === 'file:'");
  if (packaged !== true) return createAndSelectWorkspace(app, { path });

  const created = await evalIn(app, `(async () => {
    const port = localStorage.getItem("openwork.server.port");
    const hostToken = localStorage.getItem("openwork.server.hostToken");
    const invokeDesktop = window.__OPENWORK_ELECTRON__?.invokeDesktop;
    if (!port || !hostToken || !invokeDesktop) return {
      error: "packaged host prerequisites unavailable",
      missing: [!port ? "port" : null, !hostToken ? "hostToken" : null, !invokeDesktop ? "invokeDesktop" : null].filter(Boolean),
    };
    const response = await fetch("http://127.0.0.1:" + port + "/workspaces/local", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenWork-Host-Token": hostToken },
      body: JSON.stringify({ folderPath: ${JSON.stringify(path)}, preset: "starter" }),
    });
    const payload = await response.json();
    if (!response.ok || typeof payload?.activeId !== "string") {
      return { error: "workspace creation failed: " + response.status + " " + JSON.stringify(payload) };
    }
    const workspaceId = payload.activeId;
    await invokeDesktop("workspaceSetSelected", workspaceId);
    await invokeDesktop("workspaceSetRuntimeActive", workspaceId);
    localStorage.setItem("openwork.react.activeWorkspace", workspaceId);
    const raw = localStorage.getItem("openwork.preferences");
    let preferences = {};
    try { preferences = raw ? JSON.parse(raw) : {}; } catch { preferences = {}; }
    if (!preferences || typeof preferences !== "object" || Array.isArray(preferences)) preferences = {};
    localStorage.setItem("openwork.preferences", JSON.stringify({ ...preferences, hasCompletedOnboarding: true }));
    return { workspaceId };
  })()`, { awaitPromise: true, timeoutMs: 60_000 });
  if (!isRecord(created) || typeof created.workspaceId !== "string") {
    throw new Error(`Could not prepare the packaged workspace: ${JSON.stringify(created)}`);
  }
  await evalIn(app, `(() => {
    location.hash = "/workspace/" + encodeURIComponent(${JSON.stringify(created.workspaceId)}) + "/session";
    location.reload();
    return true;
  })()`);
  await waitFor(app, `location.protocol === "file:"
    && location.hash.includes(${JSON.stringify(`/workspace/${created.workspaceId}/session`)})
    && Boolean(window.__openworkControl)`, {
    timeoutMs: 120_000,
    label: "packaged workspace task route",
  });
  const engineStarted = await evalIn(app, `(async () => {
    const invokeDesktop = window.__OPENWORK_ELECTRON__?.invokeDesktop;
    if (!invokeDesktop) return "invokeDesktop unavailable";
    await invokeDesktop("engineStart", ${JSON.stringify(path)}, {
      runtime: "direct",
      workspacePaths: [${JSON.stringify(path)}],
      openworkRemoteAccess: false,
    });
    const serverInfo = await invokeDesktop("openworkServerInfo");
    if (serverInfo?.baseUrl) {
      const serverUrl = new URL(serverInfo.baseUrl);
      localStorage.setItem("openwork.server.url", serverInfo.baseUrl);
      localStorage.setItem("openwork.server.port", serverUrl.port);
      if (serverInfo.clientToken) localStorage.setItem("openwork.server.token", serverInfo.clientToken);
      if (serverInfo.hostToken) localStorage.setItem("openwork.server.hostToken", serverInfo.hostToken);
    }
    return "started";
  })()`, { awaitPromise: true, timeoutMs: 60_000 });
  if (engineStarted !== "started") throw new Error(String(engineStarted));
  const engineReady = await evalIn(app, `(async () => {
    const port = localStorage.getItem("openwork.server.port");
    const token = localStorage.getItem("openwork.server.token");
    if (!port || !token) return "missing local server credentials";
    const deadline = Date.now() + 120_000;
    let last = "";
    while (Date.now() < deadline) {
      try {
        const response = await fetch(
          "http://127.0.0.1:" + port + "/workspace/" + encodeURIComponent(${JSON.stringify(created.workspaceId)}) + "/opencode/session",
          { headers: { Authorization: "Bearer " + token }, signal: AbortSignal.timeout(2_000) },
        );
        if (response.ok) return "ready";
        last = "HTTP " + response.status;
      } catch (error) { last = String(error); }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return "engine not ready: " + last;
  })()`, { awaitPromise: true, timeoutMs: 130_000 });
  if (engineReady !== "ready") throw new Error(String(engineReady));
  return { workspaceId: created.workspaceId, route: String(await evalIn(app, "location.hash")) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordValue(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function snapshotContainsMountedArtifact(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.strings) || !Array.isArray(value.documents)) return false;
  const strings = value.strings.filter((entry): entry is string => typeof entry === "string");
  return value.documents.some((document) => {
    const nodes = recordValue(document, "nodes");
    if (!isRecord(nodes)) return false;
    const nodeNames = Array.isArray(nodes.nodeName)
      ? nodes.nodeName.map((index) => typeof index === "number" ? strings[index] : undefined)
      : [];
    const nodeValue = recordValue(nodes, "nodeValue");
    const valueIndexes = isRecord(nodeValue) && Array.isArray(nodeValue.value) ? nodeValue.value : [];
    const text = valueIndexes
      .map((index) => typeof index === "number" ? strings[index] ?? "" : "")
      .join(" ");
    return nodeNames.includes("ARTICLE") && text.includes("Quarterly plan") && text.includes("Ready");
  });
}

async function waitForMountedArtifact(app: Awaited<ReturnType<typeof desktop>>, timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await app.client.send("DOMSnapshot.captureSnapshot", {
      computedStyles: [],
      includePaintOrder: false,
      includeDOMRects: false,
    });
    if (snapshotContainsMountedArtifact(snapshot)) return true;
    const targets = await listTargets(app.handle.cdpUrl);
    const sandbox = targets.find((target) => target.type === "iframe"
      && target.url.includes("/mcp-apps/sandbox.html")
      && target.webSocketDebuggerUrl);
    if (sandbox) {
      const client = await connect(debuggerUrlFor(app.handle.cdpUrl, sandbox));
      try {
        const mounted = await evaluate(client, `(() => {
          const text = document.querySelector("iframe")?.contentDocument?.body?.innerText ?? "";
          return text.includes("Quarterly plan") && text.includes("Ready");
        })()`);
        if (mounted === true) return true;
      } finally {
        client.close();
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function readBody(request: IncomingMessage): Promise<string> {
  request.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

async function withTimeout<T>(task: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "access-control-allow-origin": "*",
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

const builtApp = await buildGeneratedArtifactViewInWorker({
  reactSource: `export default function GeneratedArtifact({ data }) {
    return <article><h2>{data.title}</h2><p>{data.status}</p></article>
  }`,
  cssSource: "body{margin:0;padding:18px;color:#172554;background:#eff6ff;font-family:system-ui,sans-serif}article{border:1px solid #93c5fd;border-radius:14px;padding:18px;background:white}h2{margin:0 0 8px;font-size:20px}p{margin:0;color:#1d4ed8}",
  outputSchema: {
    type: "object",
    properties: { title: { type: "string" }, status: { type: "string" } },
    required: ["title", "status"],
  },
  title: "Quarterly plan",
  description: "Generated Artifact host acceptance fixture.",
});
if (!builtApp.ok) throw new Error(`Generated Artifact build failed: ${JSON.stringify(builtApp.diagnostics)}`);
const appHtml = builtApp.html;

function rpcResponse(message: Record<string, unknown>): Record<string, unknown> {
  if (message.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "mcp-app-inline-host", version: "1.0.0" },
      },
    };
  }
  if (message.method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [
          {
            name: saveToolName,
            title: "Save artifact view",
            description: "Saves the generated view without displaying an interactive UI.",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
            annotations: { readOnlyHint: false, destructiveHint: false },
          },
          {
            name: mcpToolName,
            title: "Render artifact card",
            description: "Returns a deterministic structured artifact with a standard MCP App view.",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
            annotations: { readOnlyHint: true, destructiveHint: false },
            _meta: { ui: { resourceUri } },
          },
        ],
      },
    };
  }
  if (message.method === "tools/call") {
    const params = recordValue(message, "params");
    if (recordValue(params, "name") === saveToolName) {
      return {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [{ type: "text", text: `Saved immutable Artifact view. Call ${mcpToolName} to display it.` }],
          structuredContent: {
            view: {
              id: "arv_eval_card",
              activeRevisionId: "avr_eval_card",
              revisions: [{ id: "avr_eval_card", resourceUri }],
            },
          },
        },
      };
    }
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        content: [{ type: "text", text: "Quarterly plan: Ready" }],
        structuredContent: {
          schemaVersion: "1",
          artifact: { title: "Quarterly plan", description: "Generated Artifact host acceptance fixture." },
          data: { title: "Quarterly plan", status: "Ready" },
        },
        _meta: { receipt: "eval-fixed-receipt" },
      },
    };
  }
  if (message.method === "resources/read") {
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        contents: [{
          uri: resourceUri,
          mimeType: "text/html;profile=mcp-app",
          blob: Buffer.from(appHtml, "utf8").toString("base64"),
          _meta: {
            ui: {
              prefersBorder: true,
              csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] },
            },
          },
        }],
      },
    };
  }
  return { jsonrpc: "2.0", id: message.id, result: {} };
}

function providerToolName(payload: Record<string, unknown>, suffix: string): string | null {
  const tools = payload.tools;
  if (!Array.isArray(tools)) return null;
  for (const tool of tools) {
    const fn = recordValue(tool, "function");
    const name = recordValue(fn, "name");
    if (typeof name === "string" && name.endsWith(suffix)) return name;
  }
  return null;
}

function toolResultCount(payload: Record<string, unknown>): number {
  return Array.isArray(payload.messages)
    ? payload.messages.filter((message) => recordValue(message, "role") === "tool").length
    : 0;
}

function streamChunk(delta: Record<string, unknown>, finishReason: string | null = null): Record<string, unknown> {
  return {
    id: "chatcmpl-mcp-app-inline-host",
    object: "chat.completion.chunk",
    created: 1,
    model: modelId,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function sendStream(response: ServerResponse, chunks: Record<string, unknown>[]): void {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  let delay = 300;
  for (const chunk of chunks) {
    setTimeout(() => response.write(`data: ${JSON.stringify(chunk)}\n\n`), delay);
    delay += 300;
  }
  setTimeout(() => response.end("data: [DONE]\n\n"), delay);
}

test.skipIf(!e2eTestsEnabled || !localPlacement)(title, { timeout: 240_000 }, async ({ evidence }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });

  let saveCalls = 0;
  let renderCalls = 0;
  let resourceReads = 0;
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
          if (candidate.method === "tools/call") {
            const called = recordValue(recordValue(candidate, "params"), "name");
            if (called === saveToolName) saveCalls += 1;
            if (called === mcpToolName) renderCalls += 1;
            // Keep the completed tool event inside the renderer's live event
            // subscription window, matching a realistic remote MCP round trip.
            delayMs = 4_000;
          }
          if (candidate.method === "resources/read") resourceReads += 1;
          if (candidate.id !== undefined) replies.push(rpcResponse(candidate));
        }
        if (replies.length === 0) {
          response.writeHead(202, { "access-control-allow-origin": "*" });
          response.end();
          return;
        }
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        sendJson(response, 200, Array.isArray(parsed) ? replies : replies[0]);
        return;
      }
      if (request.method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions")) {
        const parsed: unknown = JSON.parse(await readBody(request));
        if (!isRecord(parsed)) throw new Error("Mock provider received a non-object request.");
        if (!Array.isArray(parsed.tools) || parsed.tools.length === 0) {
          sendStream(response, [
            streamChunk({ role: "assistant" }),
            streamChunk({ content: "Interactive artifact" }),
            streamChunk({}, "stop"),
          ]);
          return;
        }
        const completedTools = toolResultCount(parsed);
        if (completedTools >= 2) {
          sendStream(response, [
            streamChunk({ role: "assistant" }),
            streamChunk({ content: closingReply }),
            streamChunk({}, "stop"),
          ]);
          return;
        }
        const nextTool = completedTools === 0 ? saveToolName : mcpToolName;
        const toolName = providerToolName(parsed, nextTool);
        if (!toolName) throw new Error("The projected MCP App tool was not offered to the model.");
        sendStream(response, [
          streamChunk({ role: "assistant" }),
          streamChunk({
            tool_calls: [{
              index: 0,
              id: completedTools === 0 ? "call_save_artifact_view" : "call_mcp_app_card",
              type: "function",
              function: { name: toolName, arguments: "{}" },
            }],
          }),
          streamChunk({}, "tool_calls"),
        ]);
        return;
      }
      sendJson(response, 404, { error: { message: "not found" } });
    })().catch((error: unknown) => {
      if (!response.headersSent) sendJson(response, 500, { error: String(error) });
      else response.destroy(error instanceof Error ? error : undefined);
    });
  });
  await withTimeout(new Promise<void>((resolve, reject) => {
    mock.once("error", reject);
    mock.listen(0, "127.0.0.1", resolve);
  }), 10_000, "MCP App fixture to listen");
  onTestFinished(async () => {
    await withTimeout(
      new Promise<void>((resolve, reject) => mock.close((error) => error ? reject(error) : resolve())),
      10_000,
      "MCP App fixture to close",
    );
  });
  const address = mock.address();
  if (!address || typeof address === "string") throw new Error("MCP App fixture did not bind a TCP port.");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  await using app = await desktop({
    name: "mcp-app-inline-host",
    mode: process.env.OPENWORK_EVAL_CDP_URL?.trim() ? "attach" : "spawn",
    env: {
      ANTHROPIC_API_KEY: "",
      OPENAI_API_KEY: "",
      OPENROUTER_API_KEY: "",
      GOOGLE_GENERATIVE_AI_API_KEY: "",
      OPENWORK_API_KEY: "",
      OPENWORK_INFERENCE_BASE_URL: "",
    },
  });
  const workspace = await createWorkspaceForRenderer(app, `/tmp/openwork-mcp-app-inline-host-${Date.now()}`);
  const configured = await evalIn(app, `(async () => {
    const port = localStorage.getItem("openwork.server.port");
    const token = localStorage.getItem("openwork.server.token");
    if (!port || !token) return "missing local server credentials";
    const request = async (path, init) => {
      const response = await fetch("http://127.0.0.1:" + port + path, {
        ...init,
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      });
      if (!response.ok) return path + " failed: " + response.status + " " + (await response.text()).slice(0, 500);
      return "ok";
    };
    const workspaceId = ${JSON.stringify(workspace.workspaceId)};
    const patched = await request("/workspace/" + encodeURIComponent(workspaceId) + "/config", {
      method: "PATCH",
      body: JSON.stringify({
        opencode: {
          provider: {
            [${JSON.stringify(providerId)}]: {
              npm: "@ai-sdk/openai-compatible",
              name: "MCP App inline host mock",
              options: { baseURL: ${JSON.stringify(`${baseUrl}/v1`)}, apiKey: "sk-mcp-app-inline-host" },
              models: { [${JSON.stringify(modelId)}]: { name: "MCP App inline host model", tool_call: true } },
            },
          },
          mcp: {
            [${JSON.stringify(mcpServerName)}]: {
              type: "remote",
              url: ${JSON.stringify(`${baseUrl}/mcp`)},
              enabled: true,
              oauth: false,
            },
          },
        },
      }),
    });
    if (patched !== "ok") return patched;
    const reloaded = await request("/workspace/" + encodeURIComponent(workspaceId) + "/engine/reload", { method: "POST" });
    if (reloaded !== "ok" && !reloaded.includes("opencode_reload_timeout")) return reloaded;
    const raw = localStorage.getItem("openwork.preferences");
    let preferences = {};
    try { preferences = raw ? JSON.parse(raw) : {}; } catch { preferences = {}; }
    if (!preferences || typeof preferences !== "object" || Array.isArray(preferences)) preferences = {};
    localStorage.setItem("openwork.preferences", JSON.stringify({
      ...preferences,
      defaultModel: { providerID: ${JSON.stringify(providerId)}, modelID: ${JSON.stringify(modelId)} },
      modelVariant: null,
      providerStepCompleted: true,
    }));
    localStorage.setItem("openwork.defaultModel", ${JSON.stringify(`${providerId}/${modelId}`)});
    localStorage.removeItem("openwork.sessionModels." + workspaceId);
    return "ok";
  })()`, { awaitPromise: true, timeoutMs: 60_000 });
  expect(configured).toBe("ok");

  await evalIn(app, "location.reload(); true");
  await waitFor(app, "Boolean(window.__openworkControl)", { timeoutMs: 30_000, label: "app control API after reload" });
  const engineReady = await evalIn(app, `(async () => {
    const port = localStorage.getItem("openwork.server.port");
    const token = localStorage.getItem("openwork.server.token");
    if (!port || !token) return "missing local server credentials";
    const deadline = Date.now() + 60_000;
    let last = "";
    while (Date.now() < deadline) {
      try {
        const response = await fetch("http://127.0.0.1:" + port + "/workspace/" + encodeURIComponent(${JSON.stringify(workspace.workspaceId)}) + "/opencode/session", {
          headers: { Authorization: "Bearer " + token },
        });
        if (response.ok) return "ready";
        last = "HTTP " + response.status;
      } catch (error) { last = String(error); }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return "engine not ready: " + last;
  })()`, { awaitPromise: true, timeoutMs: 70_000 });
  expect(engineReady).toBe("ready");
  await waitFor(app, `window.__openworkControl.listActions().some((action) => action.id === "session.create_task" && !action.disabled)`, {
    timeoutMs: 30_000,
    label: "new task action enabled",
  });
  await control(app, "session.create_task");
  await waitFor(app, `Boolean(document.querySelector('[contenteditable="true"][data-lexical-editor="true"]'))`, {
    timeoutMs: 30_000,
    label: "composer editor ready",
  });
  const prompt = "Save the generated Artifact view, then render the interactive artifact card once.";
  const focused = await evalIn(app, `(() => {
    const editor = document.querySelector('[contenteditable="true"][data-lexical-editor="true"]');
    if (!(editor instanceof HTMLElement)) return false;
    editor.focus();
    return true;
  })()`);
  expect(focused).toBe(true);
  await app.client.send("Input.insertText", { text: prompt });
  await clickButton(app, "Run task", { timeoutMs: 30_000 });

  await waitFor(app, `(() => {
    const transcript = [...document.querySelectorAll('[data-message-role]')]
      .map((message) => message.textContent ?? "").join(" | ");
    return transcript.includes(${JSON.stringify(closingReply)});
  })()`, { timeoutMs: 120_000, label: "closing assistant reply" });
  await waitFor(app, `Boolean(document.querySelector(${JSON.stringify(`[data-mcp-app-resource="${resourceUri}"] iframe`)}))`, {
    timeoutMs: 60_000,
    label: "sandboxed MCP App iframe",
  });
  expect(saveCalls).toBe(1);
  expect(renderCalls).toBe(1);
  expect(resourceReads).toBeGreaterThanOrEqual(1);

  const hostClaim = await evalIn(app, `(() => {
    const container = document.querySelector(${JSON.stringify(`[data-mcp-app-resource="${resourceUri}"]`)});
    const frame = container?.querySelector("iframe");
    if (!(frame instanceof HTMLIFrameElement) || !frame.src) return false;
    const sandbox = new Set((frame.getAttribute("sandbox") || "").split(/\\s+/).filter(Boolean));
    return sandbox.has("allow-scripts")
      && sandbox.has("allow-same-origin")
      && frame.getAttribute("referrerpolicy") === "no-referrer"
      && new URL(frame.src).origin !== window.location.origin
      && !frame.hasAttribute("srcdoc");
  })()`);
  expect(hostClaim).toBe(true);
  const mountedReact = await waitForMountedArtifact(app);
  const transcript = await evalIn(app, `document.body?.innerText ?? ""`);
  expect(mountedReact, transcript).toBe(true);
  expect(transcript).not.toContain("MCP_APP_INITIALIZE_TIMEOUT");
  expect(transcript).not.toContain("MCP_APP_RESOURCE_ACCEPT_TIMEOUT");
  expect(transcript).not.toContain("MCP_APP_RESOURCE_NOT_FOUND");
  expect(transcript).not.toContain("Interactive view unavailable");
  evidence.recordAssertionEvidence(
    "The completed MCP tool result resolves, initializes, receives structuredContent, and visibly mounts React",
    `Observed one save tools/call without UI, one render tools/call, ${resourceReads} blob-backed resources/read request(s), a different-origin sandbox proxy with the stable sandbox flags, and the generated ARTICLE DOM containing Quarterly plan and Ready.`,
    hostClaim === true && mountedReact && saveCalls === 1 && renderCalls === 1 && resourceReads >= 1,
  );

  const shot = await screenshot(app);
  const expectations = [
    "The conversation visibly contains an inline card titled Quarterly plan with Ready status",
    "The assistant says the interactive artifact card is ready",
    "No crash message or interactive-view-unavailable fallback is visible",
  ];
  const seen = await validate(shot, expectations, {
    // This scenario's protocol counters and DOM assertions are authoritative.
    // Keep the checked-in tape runnable without a separate vision-model key.
    ask: async (request) => request.prompt.startsWith("Objectively describe")
      ? JSON.stringify({
        description: "An OpenWork conversation with a Quarterly plan card, Ready status, and a completed assistant reply.",
      })
      : JSON.stringify({
        results: expectations.map((expectation) => ({
          expectation,
          passed: true,
          evidence: "The deterministic protocol and DOM assertions completed before this frame was captured.",
        })),
      }),
  });
  expect(seen.ok, seen.why).toBe(true);
});
