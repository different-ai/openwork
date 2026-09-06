import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clickButton, control, createAndSelectWorkspace, evalIn, go, renameSessionAndWait, waitFor } from "@openwork/behaviors";
import type { Surface } from "@openwork/cdp";
import { desktop } from "@openwork/hosts";
import { needs, resolveEvalEngine, test } from "@openwork/testkit";
import { expect } from "vitest";

const enabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const title = enabled
  ? "chat routing switches live between OpenCode v1 and the v2 preview sidecar"
  : "OpenCode v2 chat routing skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1";
const keyV1 = "key-v1";
const keyV2 = "key-v2";
const modelIdV1 = "witness-model-v1";
const modelIdV2 = "witness-model-v2";
const modelNameV1 = "Witness Model V1";
const modelNameV2 = "Witness Model V2";
const generatedTitle = "A friendly greeting";
const manualTitle = "My chosen thread name";

interface EngineV2PreviewStatus {
  enabled: boolean;
  running: boolean;
  chatRouting: boolean;
  pid?: number;
  mirroredProviderIds: string[];
  skippedProviderIds: string[];
  catalogModelIds: string[];
  lastError?: string;
}

interface ServerFetchResult {
  status: number;
  json: unknown;
}

interface WitnessRequest {
  at: number;
  auth: string;
  model: string;
  stream: boolean;
  nonce: string;
  titleRequest: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));



function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`Engine v2 status ${field} was not a string array: ${JSON.stringify(value)}`);
  }
  return value;
}

function parseStatus(value: unknown): EngineV2PreviewStatus {
  if (
    !isRecord(value)
    || typeof value.enabled !== "boolean"
    || typeof value.running !== "boolean"
    || typeof value.chatRouting !== "boolean"
  ) {
    throw new Error(`Unexpected engine v2 preview status: ${JSON.stringify(value)}`);
  }
  if (value.pid !== undefined && typeof value.pid !== "number") {
    throw new Error(`Unexpected engine v2 pid: ${JSON.stringify(value.pid)}`);
  }
  return {
    enabled: value.enabled,
    running: value.running,
    chatRouting: value.chatRouting,
    ...(typeof value.pid === "number" ? { pid: value.pid } : {}),
    mirroredProviderIds: stringArray(value.mirroredProviderIds, "mirroredProviderIds"),
    skippedProviderIds: stringArray(value.skippedProviderIds, "skippedProviderIds"),
    catalogModelIds: stringArray(value.catalogModelIds, "catalogModelIds"),
    ...(typeof value.lastError === "string" ? { lastError: value.lastError } : {}),
  };
}

async function serverFetchJson(
  app: Surface,
  path: string,
  init: { method?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<ServerFetchResult> {
  const timeoutMs = init.timeoutMs ?? 15_000;
  const requestBody = init.body === undefined ? undefined : JSON.stringify(init.body);
  if (init.body !== undefined && requestBody === undefined) throw new Error(`Could not serialize request body for ${path}`);
  const value = await evalIn(app, `(async () => {
    const port = (localStorage.getItem("openwork.server.port") ?? "").trim();
    const token = (localStorage.getItem("openwork.server.token") ?? "").trim();
    if (!port || !token) return { specProbeError: "missing local server credentials" };
    const response = await fetch("http://127.0.0.1:" + port + ${JSON.stringify(path)}, {
      method: ${JSON.stringify(init.method ?? "GET")},
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      ${requestBody === undefined ? "" : `body: ${JSON.stringify(requestBody)},`}
      signal: AbortSignal.timeout(${timeoutMs}),
    });
    const text = await response.text();
    let json = text;
    try { json = JSON.parse(text); } catch {}
    return { status: response.status, json };
  })()`, { awaitPromise: true, timeoutMs: timeoutMs + 5_000 });
  if (!isRecord(value) || typeof value.status !== "number" || !("json" in value)) {
    throw new Error(`Server request ${path} failed: ${JSON.stringify(value)}`);
  }
  return { status: value.status, json: value.json };
}

async function readStatus(app: Surface): Promise<EngineV2PreviewStatus> {
  const result = await serverFetchJson(app, "/experimental/engine-v2-preview/status");
  if (result.status !== 200) throw new Error(`Engine v2 status returned ${result.status}: ${JSON.stringify(result.json)}`);
  return parseStatus(result.json);
}

async function untilStatus(
  app: Surface,
  predicate: (status: EngineV2PreviewStatus) => boolean,
  timeoutMs: number,
  label: string,
): Promise<EngineV2PreviewStatus> {
  const deadline = Date.now() + timeoutMs;
  let last = await readStatus(app);
  while (Date.now() < deadline) {
    if (predicate(last)) return last;
    await sleep(1_000);
    last = await readStatus(app);
  }
  throw new Error(`Timed out waiting for ${label}; last status: ${JSON.stringify(last)}`);
}

async function engineSessionCount(app: Surface, workspaceId: string, lane: "opencode" | "opencode2"): Promise<number> {
  const path = lane === "opencode" ? "opencode/session?limit=100" : "opencode2/api/session";
  const result = await serverFetchJson(app, `/workspace/${encodeURIComponent(workspaceId)}/${path}`);
  if (lane === "opencode2" && result.status === 503) return -1;
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`${lane} session list returned ${result.status}: ${JSON.stringify(result.json)}`);
  }
  if (lane === "opencode") {
    if (!Array.isArray(result.json)) throw new Error(`Unexpected v1 session list: ${JSON.stringify(result.json)}`);
    return result.json.length;
  }
  if (!isRecord(result.json) || !Array.isArray(result.json.data)) {
    throw new Error(`Unexpected v2 session list: ${JSON.stringify(result.json)}`);
  }
  return result.json.data.length;
}

const engineSelectedExpression = (engine: "v1" | "v2", options: { ready?: boolean } = {}) => `(() => {
  const group = document.querySelector('[aria-label="Chat engine"]');
  if (!group) return false;
  ${options.ready ? 'if (group.getAttribute("aria-disabled") === "true" || group.hasAttribute("data-disabled")) return false;' : ""}
  const control = group.querySelector('[data-engine="${engine}"]');
  return control?.getAttribute("aria-pressed") === "true" || control?.getAttribute("data-state") === "on";
})()`;

async function clickEngineOption(app: Surface, engine: "v1" | "v2"): Promise<void> {
  const point = await evalIn(app, `(() => {
    const control = [...document.querySelectorAll('[aria-label="Chat engine"] [data-engine="${engine}"]')]
      .find((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
    if (!(control instanceof HTMLElement)) return null;
    control.scrollIntoView({ block: "center", behavior: "instant" });
    const rect = control.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  if (!isRecord(point) || typeof point.x !== "number" || typeof point.y !== "number") {
    throw new Error(`Could not resolve the ${engine} chat engine option: ${JSON.stringify(point)}`);
  }
  await app.client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
  await app.client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
  await app.client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
}

async function closeModelPicker(app: Surface): Promise<void> {
  await app.client.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
  });
  await app.client.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
  });
}

async function waitForModelInPicker(app: Surface, expected: string, timeoutMs = 45_000): Promise<void> {
  await waitFor(app, `Boolean(document.querySelector('button[aria-label="Change model"]'))`, {
    timeoutMs: 30_000,
    label: "composer model picker",
  });
  const deadline = Date.now() + timeoutMs;
  let lastItems: string[] = [];
  while (Date.now() < deadline) {
    const opened = await evalIn(app, `(() => {
      if (document.querySelector('[data-slot="popover-content"]')) return true;
      const trigger = document.querySelector('button[aria-label="Change model"]');
      if (!(trigger instanceof HTMLButtonElement)) return false;
      trigger.click();
      return true;
    })()`);
    if (opened === true) {
      await sleep(300);
      await evalIn(app, `(() => {
        const popover = document.querySelector('[data-slot="popover-content"]');
        if (!(popover instanceof HTMLElement)) return false;
        if ([...popover.querySelectorAll('[data-slot="command-item"]')]
          .some((item) => (item.textContent ?? "").includes(${JSON.stringify(expected)}))) return true;
        const modelButton = [...popover.querySelectorAll('button')]
          .find((button) => (button.textContent ?? "").trim().startsWith("Model"));
        if (!(modelButton instanceof HTMLButtonElement)) return false;
        modelButton.click();
        return true;
      })()`);
      await sleep(200);
      const items = await evalIn(app, `(() => {
        const popover = document.querySelector('[data-slot="popover-content"]');
        if (!(popover instanceof HTMLElement)) return [];
        return [...popover.querySelectorAll('[data-slot="command-item"]')]
          .map((item) => (item.textContent ?? "").trim());
      })()`);
      if (Array.isArray(items) && items.every((item) => typeof item === "string")) {
        lastItems = items;
        if (items.some((item) => item.includes(expected))) return;
      }
    }
    await closeModelPicker(app);
    await sleep(700);
  }
  throw new Error(`Timed out waiting for ${expected} in the model picker; last items: ${JSON.stringify(lastItems)}`);
}

async function selectModel(app: Surface, modelName: string): Promise<void> {
  await waitForModelInPicker(app, modelName);
  const picked = await evalIn(app, `(() => {
    const popover = document.querySelector('[data-slot="popover-content"]');
    const item = [...(popover?.querySelectorAll('[data-slot="command-item"]') ?? [])]
      .find((candidate) => (candidate.textContent ?? "").includes(${JSON.stringify(modelName)}));
    if (!(item instanceof HTMLElement)) return false;
    item.click();
    return true;
  })()`);
  expect(picked).toBe(true);
  await waitFor(app, `(document.querySelector('button[aria-label="Change model"]')?.textContent ?? "").includes(${JSON.stringify(modelName)})`, {
    timeoutMs: 15_000,
    label: `${modelName} selected`,
  });
}

async function typeIntoComposer(app: Surface, text: string): Promise<void> {
  await waitFor(app, `(() => {
    const editor = document.querySelector('[contenteditable="true"][data-lexical-editor="true"]');
    return editor instanceof HTMLElement && (editor.innerText ?? "").trim() === "";
  })()`, { timeoutMs: 30_000, label: "empty composer ready" });
  const focused = await evalIn(app, `(() => {
    const editor = document.querySelector('[contenteditable="true"][data-lexical-editor="true"]');
    if (!(editor instanceof HTMLElement)) return false;
    editor.focus();
    return true;
  })()`);
  expect(focused).toBe(true);
  await app.client.send("Input.insertText", { text });
  await waitFor(app, `(document.querySelector('[contenteditable="true"][data-lexical-editor="true"]')?.innerText ?? "").trim() === ${JSON.stringify(text)}`, {
    timeoutMs: 10_000,
    label: `composer contains ${text}`,
  });
}

async function createNewSessionThroughSidebar(app: Surface): Promise<string> {
  const previousValue = await evalIn(app, `document.querySelector('[data-session-surface-id]')?.getAttribute('data-session-surface-id') ?? ""`);
  const previous = typeof previousValue === "string" ? previousValue : "";
  await waitFor(app, `(() => {
    const button = document.querySelector('[data-sidebar-new-chat]');
    return button instanceof HTMLButtonElement && !button.disabled;
  })()`, { timeoutMs: 30_000, label: "enabled sidebar New task control" });
  const clicked = await evalIn(app, `(() => {
    const button = document.querySelector('[data-sidebar-new-chat]');
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  })()`);
  expect(clicked).toBe(true);
  await waitFor(app, `(() => {
    const id = document.querySelector('[data-session-surface-id]')?.getAttribute('data-session-surface-id') ?? "";
    return id.startsWith("ses_") && id !== ${JSON.stringify(previous)}
      && window.location.hash.includes("/session/" + id);
  })()`, { timeoutMs: 60_000, label: "new session created by the active engine client" });
  const value = await evalIn(app, `document.querySelector('[data-session-surface-id]')?.getAttribute('data-session-surface-id') ?? ""`);
  if (typeof value !== "string" || !value.startsWith("ses_")) throw new Error(`New session id was unavailable: ${String(value)}`);
  return value;
}

async function clickSessionRow(app: Surface, sessionId: string, workspaceId: string): Promise<void> {
  const clicked = await evalIn(app, `(() => {
    const row = document.querySelector(${JSON.stringify(`[data-sidebar-session-id="${sessionId}"][data-sidebar-session-workspace-id="${workspaceId}"]`)});
    const control = row?.querySelector(${JSON.stringify(`[data-session-tab-id="${sessionId}"]`)});
    if (!(row instanceof HTMLElement) || !(control instanceof HTMLElement)) return false;
    row.scrollIntoView({ block: "center" });
    control.click();
    return true;
  })()`);
  expect(clicked).toBe(true);
}

async function waitForChatSurface(app: Surface, sessionId: string, workspaceId: string): Promise<void> {
  await waitFor(app, `(() => {
    const surface = document.querySelector("[data-session-surface-id]");
    return surface?.getAttribute("data-session-surface-id") === ${JSON.stringify(sessionId)}
      && (localStorage.getItem("openwork.react.activeWorkspace") ?? "") === ${JSON.stringify(workspaceId)};
  })()`, { timeoutMs: 10_000, label: "v2 session surface after workspace switch" });
}

async function expectSessionTitle(app: Surface, sessionId: string, workspaceId: string, expected: string): Promise<void> {
  const selector = `[data-sidebar-session-id="${sessionId}"][data-sidebar-session-workspace-id="${workspaceId}"] [data-session-title-text]`;
  await waitFor(app, `(document.querySelector(${JSON.stringify(selector)})?.textContent ?? "").trim() === ${JSON.stringify(expected)}`, {
    timeoutMs: 45_000,
    label: `sidebar title becomes ${expected}`,
  });
  const result = await serverFetchJson(app, `/workspace/${encodeURIComponent(workspaceId)}/opencode2/api/session/${encodeURIComponent(sessionId)}`);
  expect(result.status).toBe(200);
  expect(result.json).toMatchObject({ data: { id: sessionId, title: expected } });
}

async function waitForWitnessRequest(
  requests: WitnessRequest[],
  predicate: (request: WitnessRequest) => boolean,
  label: string,
): Promise<WitnessRequest> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const match = requests.find(predicate);
    if (match) return match;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}; requests: ${JSON.stringify(requests)}`);
}

async function sendAndWaitForNonce(
  app: Surface,
  requests: WitnessRequest[],
  prompt: string,
  auth: string,
  model: string,
  notBefore: number,
  round: string,
): Promise<{ request: WitnessRequest; latencyMs: number }> {
  await typeIntoComposer(app, prompt);
  const sentAt = Date.now();
  await clickButton(app, "Run task", { timeoutMs: 30_000 });
  const request = await waitForWitnessRequest(
    requests,
    (candidate) => candidate.stream && !candidate.titleRequest && candidate.at >= sentAt && candidate.at >= notBefore
      && candidate.auth === auth && candidate.model === model,
    `${round} streamed witness request`,
  );
  await waitFor(app, `[...document.querySelectorAll('[data-message-role="assistant"]')]
    .some((message) => message.textContent?.includes(${JSON.stringify(request.nonce)}))`, {
    timeoutMs: 120_000,
    label: `${round} transcript nonce ${request.nonce}`,
  });
  const latencyMs = Date.now() - sentAt;
  console.info(`[opencode-v2-chat-routing] ${round} send-to-nonce latency: ${latencyMs}ms`);
  return { request, latencyMs };
}

test.skipIf(!enabled)(title, { timeout: 600_000 }, async ({ evidence, place, skip }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });

  const evalEngine = resolveEvalEngine();
  const binPath = place.kind === "local" ? process.env.OPENWORK_EVAL_OPENCODE2_BIN?.trim() || undefined : undefined;
  const witnessRequests: WitnessRequest[] = [];
  const validAuth = new Set([`Bearer ${keyV1}`, `Bearer ${keyV2}`]);
  const witness = createServer((request, response) => {
    const url = request.url ?? "";
    const auth = request.headers.authorization ?? "";
    if (!validAuth.has(auth)) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "invalid witness key" } }));
      return;
    }
    if (request.method === "GET" && url.startsWith("/v1/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        object: "list",
        data: [modelIdV1, modelIdV2].map((id) => ({ id, object: "model" })),
      }));
      return;
    }
    if (request.method !== "POST" || (url !== "/v1/chat/completions" && url !== "/chat/completions")) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "not found" } }));
      return;
    }

    request.setEncoding("utf8");
    let rawBody = "";
    request.on("data", (chunk: string) => {
      rawBody += chunk;
    });
    request.on("end", () => {
      let body: unknown;
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = null;
      }
      const model = isRecord(body) && typeof body.model === "string" ? body.model : "";
      const stream = isRecord(body) && body.stream === true;
      // Title generation is tool-free in both engines and can also stream.
      const titleRequest = isRecord(body) && (!Array.isArray(body.tools) || body.tools.length === 0);
      const nonce = titleRequest ? generatedTitle : `OPENWORK-V2-ROUTING-NONCE-${witnessRequests.length + 1}`;
      witnessRequests.push({ at: Date.now(), auth, model, stream, nonce, titleRequest });
      const id = `chatcmpl-opencode-v2-routing-${witnessRequests.length}`;
      if (!stream) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          id,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1_000),
          model,
          choices: [{ index: 0, message: { role: "assistant", content: nonce }, finish_reason: "stop" }],
        }));
        return;
      }
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const chunk = (delta: Record<string, string>, finishReason: string | null): void => {
        response.write(`data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          model,
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        })}\n\n`);
      };
      chunk({ role: "assistant" }, null);
      chunk({ content: nonce }, null);
      chunk({}, "stop");
      response.end("data: [DONE]\n\n");
    });
  });
  let witnessBaseUrl: string | undefined;
  if (place.kind === "local") {
    await new Promise<void>((resolve, reject) => {
      witness.once("error", reject);
      witness.listen(0, "127.0.0.1", resolve);
    });
    const address = witness.address();
    if (!address || typeof address === "string") throw new Error("Witness server did not bind a TCP port");
    witnessBaseUrl = `http://127.0.0.1:${address.port}/v1`;
  }
  const profileDir = place.kind === "local"
    ? await mkdtemp(join(tmpdir(), "openwork-v2-chat-routing-eval-"))
    : undefined;

  let app: Awaited<ReturnType<typeof desktop>> | undefined;
  try {
    app = await desktop({
      name: "opencode-v2-chat-routing",
      host: place.host(),
      ...(profileDir === undefined ? {} : { profileDir }),
      env: {
        // This benchmark measures engine and UI latency, not plugins. On a fresh isolated HOME, the engine's external-plugin dependency bootstrap
        // (injected by apps/server/src/openwork-runtime-config.ts) can hold its install lock for minutes and block /config + /provider, so the picker
        // reports "No models found" and the run times out. OPENCODE_PURE skips plugin loading for both the v1 and v2 lanes alike.
        OPENCODE_PURE: "true",
        ...(binPath === undefined ? {} : { OPENWORK_OPENCODE2_BIN: binPath }),
        ANTHROPIC_API_KEY: "",
        OPENAI_API_KEY: "",
        OPENROUTER_API_KEY: "",
        GOOGLE_GENERATIVE_AI_API_KEY: "",
        OPENWORK_API_KEY: "",
        OPENWORK_INFERENCE_BASE_URL: "",
      },
    });
    let workspacePath: string;
    let secondWorkspacePath: string;
    if (place.kind === "daytona") {
      if (!app.workspaceRoot) throw new Error("Daytona desktop did not expose its workspace root");
      const workspaceRunRoot = `${app.workspaceRoot}/evals-tmp/opencode-v2-chat-routing-${Date.now()}`;
      workspacePath = `${workspaceRunRoot}/workspace`;
      secondWorkspacePath = `${workspaceRunRoot}/workspace-2`;
    } else {
      if (profileDir === undefined) throw new Error("Local desktop profile directory was unavailable");
      workspacePath = join(profileDir, "workspace");
      secondWorkspacePath = join(profileDir, "workspace-2");
      await mkdir(workspacePath, { recursive: true });
      await mkdir(secondWorkspacePath, { recursive: true });
    }
    if (witnessBaseUrl !== undefined) {
      await writeFile(join(workspacePath, "opencode.json"), `${JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        provider: {
          "witness-v1": {
            npm: "@ai-sdk/openai-compatible",
            name: "Witness V1",
            options: { baseURL: witnessBaseUrl, apiKey: keyV1 },
            models: { [modelIdV1]: { name: modelNameV1 } },
          },
        },
      }, null, 2)}\n`);
    }
    const { workspaceId } = await createAndSelectWorkspace(app, { path: workspacePath });
    const harnessLaneStatus = evalEngine === "v2"
      ? await untilStatus(
        app,
        (status) => status.enabled && status.chatRouting && status.running && typeof status.pid === "number",
        180_000,
        "the harness-selected OpenCode v2 chat lane to start",
      )
      : undefined;
    if (harnessLaneStatus !== undefined) {
      evidence.recordAssertionEvidence(
        "harness lane switch routes chat through v2 with no in-spec flag flip",
        `OPENWORK_EVAL_ENGINE=v2 started the app with preview enabled, chat routing enabled, and sidecar pid ${harnessLaneStatus.pid}; the spec had not changed either preview setting.`,
        true,
      );
    }
    if (place.kind === "daytona") {
      if (harnessLaneStatus === undefined) await readStatus(app);
      skip("needs: local placement for witness round-trip claims R1–R4 because Daytona cannot expose the spec process's 127.0.0.1 mock");
    }
    if (witnessBaseUrl === undefined) throw new Error("Local witness URL was unavailable");

    let runningStatus = harnessLaneStatus;
    if (runningStatus === undefined) {
      await selectModel(app, modelNameV1);
      const v2BeforeEnable = await engineSessionCount(app, workspaceId, "opencode2");
      expect(v2BeforeEnable).toBe(-1);
      const r1 = await sendAndWaitForNonce(
        app,
        witnessRequests,
        "hello r1",
        `Bearer ${keyV1}`,
        modelIdV1,
        0,
        "R1 v1",
      );
      expect(r1.request.auth).toBe(`Bearer ${keyV1}`);
      expect(r1.request.model).toBe(modelIdV1);
      expect(witnessRequests.some((request) => request.auth === `Bearer ${keyV2}`)).toBe(false);
      evidence.recordAssertionEvidence(
        "R1 chat stays on v1 before the preview is enabled",
        `The transcript streamed ${r1.request.nonce} from ${modelIdV1} with Bearer ${keyV1} in ${r1.latencyMs}ms; the v2 proxy returned 503 and no request used Bearer ${keyV2}.`,
        true,
      );

      await go(app, `/workspace/${workspaceId}/settings/advanced`);
      await waitFor(app, engineSelectedExpression("v1", { ready: true }), { timeoutMs: 60_000, label: "ready chat engine control on v1" });
      await clickEngineOption(app, "v2");
      runningStatus = await untilStatus(
        app,
        (status) => status.enabled && status.running && typeof status.pid === "number",
        180_000,
        "the OpenCode v2 sidecar to start",
      );
      await untilStatus(app, (status) => status.chatRouting, 30_000, "chat routing to be enabled");
    }
    const pid0 = runningStatus.pid;
    if (pid0 === undefined) throw new Error("Running OpenCode v2 status did not contain a pid");
    const routedOnAt = Date.now();

    const patchResponse = await serverFetchJson(app, `/workspace/${encodeURIComponent(workspaceId)}/config`, {
      method: "PATCH",
      body: {
        opencode: {
          provider: {
            "witness-v2": {
              npm: "@ai-sdk/openai-compatible",
              name: "Witness V2",
              options: { baseURL: witnessBaseUrl, apiKey: keyV2 },
              models: { [modelIdV2]: { name: modelNameV2 } },
            },
          },
        },
      },
    });
    expect(patchResponse.status).toBe(200);
    const patchCompletedAt = Date.now();
    await untilStatus(
      app,
      (status) => status.mirroredProviderIds.includes("witness-v2"),
      60_000,
      "the v2 witness provider to be mirrored",
    );
    const mirrorLatencyMs = Date.now() - patchCompletedAt;
    const catalogStatus = await untilStatus(
      app,
      (status) => status.catalogModelIds.includes(modelIdV2),
      120_000,
      "the v2 witness model to appear in the catalog",
    );
    const catalogLatencyMs = Date.now() - patchCompletedAt;
    expect(catalogStatus.pid).toBe(pid0);

    await go(app, `/workspace/${workspaceId}/session`);
    await waitForModelInPicker(app, modelNameV2, 45_000);
    await closeModelPicker(app);
    const v1BeforeR2 = await engineSessionCount(app, workspaceId, "opencode");
    const v2BeforeR2 = await engineSessionCount(app, workspaceId, "opencode2");
    expect(v2BeforeR2).toBeGreaterThanOrEqual(0);

    // New task uses the selected workspace's currently swapped client. This
    // avoids sending a v2 prompt to the pre-toggle v1 session id.
    const v2SessionId = await createNewSessionThroughSidebar(app);
    await waitFor(app, `(document.querySelector(${JSON.stringify(`[data-sidebar-session-id="${v2SessionId}"] [data-session-title-text]`)})?.textContent ?? "").trim() === "New session"`, {
      timeoutMs: 15_000,
      label: "an unnamed v2 session is displayed as a new session, not a finished title",
    });
    await selectModel(app, modelNameV2);
    const r2 = await sendAndWaitForNonce(
      app,
      witnessRequests,
      "hello r2",
      `Bearer ${keyV2}`,
      modelIdV2,
      routedOnAt,
      "R2 v2",
    );
    const v1AfterR2 = await engineSessionCount(app, workspaceId, "opencode");
    const v2AfterR2 = await engineSessionCount(app, workspaceId, "opencode2");
    expect(v2AfterR2).toBeGreaterThan(v2BeforeR2);
    expect(v1AfterR2).toBe(v1BeforeR2);
    expect(r2.request.at).toBeGreaterThanOrEqual(routedOnAt);
    expect(r2.request.auth).toBe(`Bearer ${keyV2}`);
    expect(r2.request.model).toBe(modelIdV2);
    await expectSessionTitle(app, v2SessionId, workspaceId, generatedTitle);
    evidence.recordAssertionEvidence(
      "R2 routed chat creates and streams through v2 without touching v1",
      `The provider mirrored in ${mirrorLatencyMs}ms and its catalog warmed in ${catalogLatencyMs}ms without restarting pid ${pid0}; the v2 transcript streamed ${r2.request.nonce} from ${modelIdV2} with Bearer ${keyV2} in ${r2.latencyMs}ms; v2 sessions grew ${v2BeforeR2}→${v2AfterR2}, while v1 stayed frozen at ${v1BeforeR2}.`,
      true,
    );

    await createAndSelectWorkspace(app, { path: secondWorkspacePath });
    await sleep(31_000);
    await clickSessionRow(app, v2SessionId, workspaceId);
    await waitForChatSurface(app, v2SessionId, workspaceId);
    await sleep(1_000);
    // Guards the dev #4364 refetch-on-select interaction: the sidebar must list from the routed engine
    // (`route-workspaces.ts` v2 transport), never drop a v2 session because the refetch listed v1.
    await waitFor(app, `Boolean(document.querySelector(${JSON.stringify(`[data-sidebar-session-id="${v2SessionId}"][data-sidebar-session-workspace-id="${workspaceId}"]`)}))`, {
      timeoutMs: 10_000,
      label: "v2 session remains in the sidebar after switching workspaces",
    });
    await expectSessionTitle(app, v2SessionId, workspaceId, generatedTitle);
    evidence.recordAssertionEvidence(
      "an unnamed v2 thread gains a title and keeps it after workspace refetch",
      "The sidebar initially showed New session, then the tool-free title response rather than the chat response; the native session API and the same sidebar row retained that title after leaving and reopening the thread.",
      true,
    );

    const namedSessionId = await createNewSessionThroughSidebar(app);
    const renameApp = app;
    await renameSessionAndWait((action, args) => control(renameApp, action, args), namedSessionId, manualTitle);
    await selectModel(app, modelNameV2);
    const titleRequestsBefore = witnessRequests.filter((request) => request.titleRequest).length;
    await sendAndWaitForNonce(app, witnessRequests, "hello from my named thread", `Bearer ${keyV2}`, modelIdV2, routedOnAt, "Named v2");
    await expectSessionTitle(app, namedSessionId, workspaceId, manualTitle);
    await clickSessionRow(app, v2SessionId, workspaceId);
    await waitForChatSurface(app, v2SessionId, workspaceId);
    await expectSessionTitle(app, v2SessionId, workspaceId, generatedTitle);
    await clickSessionRow(app, namedSessionId, workspaceId);
    await waitForChatSurface(app, namedSessionId, workspaceId);
    await expectSessionTitle(app, namedSessionId, workspaceId, manualTitle);
    expect(witnessRequests.filter((request) => request.titleRequest)).toHaveLength(titleRequestsBefore);
    evidence.recordAssertionEvidence(
      "a manually named v2 thread is not automatically renamed on its first turn",
      "A completed first reply and reopening preserved the chosen name in the sidebar and native session API, made no title request, and left the other thread's generated title unchanged.",
      true,
    );

    const statusAfterR2 = await readStatus(app);
    expect(statusAfterR2.running).toBe(true);
    expect(statusAfterR2.pid).toBe(pid0);
    evidence.recordAssertionEvidence(
      "R3 routing chat does not restart the v2 sidecar",
      `The routed send completed while the sidecar remained running at pid ${pid0}; no replacement pid appeared.`,
      true,
    );

    await go(app, `/workspace/${workspaceId}/settings/advanced`);
    await waitFor(app, engineSelectedExpression("v2"), {
      timeoutMs: 30_000,
      label: "chat engine control on v2 before reversal",
    });
    await clickEngineOption(app, "v1");
    await untilStatus(app, (status) => !status.chatRouting, 30_000, "chat routing to be disabled");
    const routedOffAt = Date.now();
    await go(app, `/workspace/${workspaceId}/session`);
    await waitForModelInPicker(app, modelNameV1, 45_000);
    await closeModelPicker(app);
    await createNewSessionThroughSidebar(app);
    await selectModel(app, modelNameV1);
    const r4 = await sendAndWaitForNonce(
      app,
      witnessRequests,
      "hello r4",
      `Bearer ${keyV1}`,
      modelIdV1,
      routedOffAt,
      "R4 v1",
    );
    // Choosing OpenCode v1 turns routing off AND stops the sidecar, so the v2
    // proxy must be unavailable again (-1), exactly as before the preview.
    const stoppedStatus = await untilStatus(app, (status) => !status.enabled && !status.running, 60_000, "the OpenCode v2 sidecar to stop");
    const v2AfterR4 = await engineSessionCount(app, workspaceId, "opencode2");
    expect(r4.request.at).toBeGreaterThanOrEqual(routedOffAt);
    expect(r4.request.auth).toBe(`Bearer ${keyV1}`);
    expect(r4.request.model).toBe(modelIdV1);
    expect(stoppedStatus.chatRouting).toBe(false);
    expect(v2AfterR4).toBe(-1);
    evidence.recordAssertionEvidence(
      "R4 choosing OpenCode v1 returns new chat to v1 and stops the sidecar",
      `After choosing v1, the transcript streamed ${r4.request.nonce} from ${modelIdV1} with Bearer ${keyV1} in ${r4.latencyMs}ms; the sidecar reported enabled=false running=false and the v2 proxy was unavailable (v2 sessions had reached ${v2AfterR2} while routed).`,
      true,
    );
  } finally {
    if (app !== undefined) await app.stop();
    if (witness.listening) {
      witness.closeAllConnections();
      await new Promise<void>((resolve, reject) => witness.close((error) => error ? reject(error) : resolve()));
    }
    if (profileDir !== undefined) await rm(profileDir, { recursive: true, force: true });
  }
});
