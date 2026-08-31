import { execFile } from "node:child_process";
import { writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import { arch, cpus, platform, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { clickButton, createAndSelectWorkspace, evalIn, readComposerState } from "@openwork/behaviors";
import type { Surface } from "@openwork/cdp";
import { desktop, localHost } from "@openwork/hosts";
import type { DesktopHandle } from "@openwork/hosts";
import { eventually, needs, test } from "@openwork/testkit";
import { timeline } from "../packages/timeline/src/index.ts";
import { expect } from "vitest";

const enabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const title = enabled
  ? "OpenWork Electron v1 engine completes the CDP benchmark with faithful witness traffic"
  : "OpenWork Electron v1 benchmark skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1";
const providerId = "bench-witness";
const modelId = "bench-model";
const modelName = "Bench Model";
const pacingMs = 20;
const tokenCount = 20;
const pollResolutionMs = 50;
const longMessageChars = 200_000;

interface WitnessRequest {
  at: string;
  auth: string;
  model: string;
  promptChars: number;
}

interface Witness {
  url: string;
  requests: WitnessRequest[];
  close(): Promise<void>;
}

interface ColdTiming {
  appInteractive: number;
  workspaceReady: number;
  composerReady: number;
  desktopTotalMs: number;
  appReadinessMs?: number;
}

interface MessageTiming {
  userRendered: number;
  firstToken: number;
  complete: number;
}

interface SwitchTiming {
  aToB: number;
  bToA: number;
}

interface LongMessageTiming extends MessageTiming {
  insertMs: number;
}

interface BenchmarkResults {
  cold_boot_to_composer: ColdTiming[];
  first_send_cold: number[];
  new_session_ready: number[];
  message_rtt: MessageTiming[];
  workspace_switch: SwitchTiming[];
  long_message: LongMessageTiming[];
}

interface SendFacts {
  timing: MessageTiming;
  sessionId: string;
  assistantText: string;
  userLength: number;
}

interface Chat {
  workspaceId: string;
  sessionId: string;
  title: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function bodyFromJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function textChars(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return value.reduce((total, entry) => total + textChars(entry), 0);
  if (!isRecord(value)) return 0;
  if (typeof value.text === "string") return value.text.length;
  return textChars(value.content);
}

function promptChars(body: unknown): number {
  if (!isRecord(body) || !Array.isArray(body.messages)) return 0;
  return body.messages.reduce((total, message) => {
    if (!isRecord(message)) return total;
    return total + textChars(message.content);
  }, 0);
}

function authorization(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value.join(",");
  return value ?? "";
}

function writeSse(response: ServerResponse, payload: unknown): boolean {
  if (response.destroyed || response.writableEnded) return false;
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
  return true;
}

async function streamWitnessCompletion(
  response: ServerResponse,
  requestId: string,
  nonce: string,
  model: string,
  requestPromptChars: number,
): Promise<void> {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  writeSse(response, {
    id: requestId,
    object: "chat.completion.chunk",
    model,
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
  });
  for (let token = 1; token <= tokenCount; token += 1) {
    await sleep(pacingMs);
    const content = token === tokenCount ? `token ${tokenCount} ${nonce}` : `token ${token} `;
    if (!writeSse(response, {
      id: requestId,
      object: "chat.completion.chunk",
      model,
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    })) return;
  }
  writeSse(response, {
    id: requestId,
    object: "chat.completion.chunk",
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: {
      prompt_tokens: Math.max(1, Math.ceil(requestPromptChars / 4)),
      completion_tokens: tokenCount,
      total_tokens: Math.max(1, Math.ceil(requestPromptChars / 4)) + tokenCount,
    },
  });
  if (!response.destroyed && !response.writableEnded) response.end("data: [DONE]\n\n");
}

async function startWitness(nonce: string): Promise<Witness> {
  const requests: WitnessRequest[] = [];
  let requestNumber = 0;
  const server = createServer((request, response) => {
    const url = request.url ?? "";
    if (request.method === "GET" && (url.startsWith("/v1/models") || url.startsWith("/models"))) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: modelId, object: "model" }] }));
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
      const body = bodyFromJson(rawBody);
      const requestedModel = isRecord(body) && typeof body.model === "string" ? body.model : "";
      const requestPromptChars = promptChars(body);
      requestNumber += 1;
      requests.push({
        at: new Date().toISOString(),
        auth: authorization(request.headers.authorization),
        model: requestedModel,
        promptChars: requestPromptChars,
      });

      const requestId = `chatcmpl-openwork-v1-bench-${requestNumber}`;
      if (isRecord(body) && body.stream === false) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          id: requestId,
          object: "chat.completion",
          model: requestedModel,
          choices: [{ index: 0, message: { role: "assistant", content: "Bench session title" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
        }));
        return;
      }
      void streamWitnessCompletion(response, requestId, nonce, requestedModel, requestPromptChars)
        .catch(() => response.destroy());
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Benchmark witness did not bind a TCP port.");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}

async function writeProviderConfig(workspacePath: string, witnessUrl: string): Promise<void> {
  await writeFile(join(workspacePath, "opencode.json"), `${JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    provider: {
      [providerId]: {
        npm: "@ai-sdk/openai-compatible",
        name: "Bench Witness",
        options: { baseURL: `${witnessUrl}/v1`, apiKey: "bench-key-app" },
        models: { [modelId]: { name: modelName } },
      },
    },
  }, null, 2)}\n`);
}

async function pollExpression(
  app: Surface,
  expression: string,
  label: string,
  within = 120_000,
): Promise<void> {
  await eventually(() => evalIn(app, expression), {
    within,
    intervalMs: pollResolutionMs,
    label,
    until: (value) => value === true,
  });
}

async function waitForComposerReady(app: Surface, label: string): Promise<void> {
  await eventually(() => readComposerState(app), {
    within: 120_000,
    intervalMs: pollResolutionMs,
    label,
    until: (state) => state.composerEditable && state.runTaskVisible,
  });
}

async function selectBenchModel(app: Surface): Promise<void> {
  await pollExpression(
    app,
    `Boolean(document.querySelector('button[aria-label="Change model"]'))`,
    "bench model picker trigger",
  );
  const opened = await evalIn(app, `(() => {
    const trigger = document.querySelector('button[aria-label="Change model"]');
    if (!(trigger instanceof HTMLButtonElement)) return false;
    trigger.click();
    return true;
  })()`);
  expect(opened).toBe(true);
  await pollExpression(
    app,
    `Boolean(document.querySelector('[data-slot="popover-content"]'))`,
    "open bench model picker",
    30_000,
  );
  const modelPaneOpened = await evalIn(app, `(() => {
    const popover = document.querySelector('[data-slot="popover-content"]');
    if (!(popover instanceof HTMLElement)) return false;
    if ([...popover.querySelectorAll('[data-slot="command-item"]')]
      .some((item) => (item.textContent ?? "").includes(${JSON.stringify(modelName)}))) return true;
    const modelButton = [...popover.querySelectorAll('button')]
      .find((button) => (button.textContent ?? "").trim().startsWith("Model"));
    if (!(modelButton instanceof HTMLButtonElement)) return false;
    modelButton.click();
    return true;
  })()`);
  expect(modelPaneOpened).toBe(true);
  await pollExpression(app, `(() => {
    const popover = document.querySelector('[data-slot="popover-content"]');
    if (!(popover instanceof HTMLElement)) return false;
    return [...popover.querySelectorAll('[data-slot="command-item"]')]
      .some((item) => (item.textContent ?? "").includes(${JSON.stringify(modelName)}));
  })()`, "Bench Model listed in picker");
  const picked = await evalIn(app, `(() => {
    const popover = document.querySelector('[data-slot="popover-content"]');
    const item = [...(popover?.querySelectorAll('[data-slot="command-item"]') ?? [])]
      .find((candidate) => (candidate.textContent ?? "").includes(${JSON.stringify(modelName)}));
    if (!(item instanceof HTMLElement)) return false;
    item.click();
    return true;
  })()`);
  expect(picked).toBe(true);
  await pollExpression(
    app,
    `(document.querySelector('button[aria-label="Change model"]')?.textContent ?? "").includes(${JSON.stringify(modelName)})`,
    "Bench Model selected",
    30_000,
  );
}

async function ensureBenchModel(app: Surface): Promise<boolean> {
  await waitForComposerReady(app, "composer before checking persisted model");
  const state = await readComposerState(app);
  if (state.selectedModelLabel.includes(modelName)) return false;
  await selectBenchModel(app);
  return true;
}

async function typeIntoComposer(app: Surface, text: string): Promise<void> {
  await pollExpression(app, `(() => {
    const editor = document.querySelector('[contenteditable="true"][data-lexical-editor="true"]');
    return editor instanceof HTMLElement && (editor.innerText ?? "").trim() === "";
  })()`, "empty composer ready");
  const focused = await evalIn(app, `(() => {
    const editor = document.querySelector('[contenteditable="true"][data-lexical-editor="true"]');
    if (!(editor instanceof HTMLElement)) return false;
    editor.focus();
    return true;
  })()`);
  expect(focused).toBe(true);
  await app.client.send("Input.insertText", { text });
  const expectedLength = text.length;
  const expectedStart = text.slice(0, 64);
  const expectedEnd = text.slice(-64);
  await pollExpression(app, `(() => {
    const value = document.querySelector('[contenteditable="true"][data-lexical-editor="true"]')?.innerText ?? "";
    return value.length === ${expectedLength}
      && value.startsWith(${JSON.stringify(expectedStart)})
      && value.endsWith(${JSON.stringify(expectedEnd)});
  })()`, `composer contains ${expectedLength} inserted characters`);
}

async function activeSessionId(app: Surface): Promise<string> {
  return eventually(async () => {
    const value = await evalIn(
      app,
      `document.querySelector("[data-session-surface-id]")?.getAttribute("data-session-surface-id") ?? ""`,
    );
    return typeof value === "string" ? value : "";
  }, {
    within: 60_000,
    intervalMs: pollResolutionMs,
    label: "active session id",
    until: (value) => value.startsWith("ses_"),
  });
}

async function measurePreparedSend(
  app: Surface,
  beforeUserCount: number,
  expectedUserMarker: string,
  witnessNonce: string,
): Promise<SendFacts> {
  const startedAt = Date.now();
  await clickButton(app, "Run task", { timeoutMs: 30_000 });
  await pollExpression(app, `(() => {
    const messages = [...document.querySelectorAll('[data-message-role="user"]')];
    const latest = messages[messages.length - 1];
    return messages.length > ${beforeUserCount}
      && (latest?.innerText ?? "").includes(${JSON.stringify(expectedUserMarker)});
  })()`, `user message rendered for ${expectedUserMarker.slice(0, 80)}`);
  const userRendered = Date.now() - startedAt;
  const sessionId = await activeSessionId(app);
  await pollExpression(app, `(() => {
    const messages = [...document.querySelectorAll('[data-message-role="assistant"]')];
    const latest = messages[messages.length - 1];
    return (latest?.innerText ?? "").includes("token 1 ");
  })()`, `first witness token in ${sessionId}`);
  const firstToken = Date.now() - startedAt;
  await pollExpression(app, `(() => {
    const messages = [...document.querySelectorAll('[data-message-role="assistant"]')];
    const latest = messages[messages.length - 1];
    const text = latest?.innerText ?? "";
    const row = document.querySelector(${JSON.stringify(`[data-sidebar-session-id="${sessionId}"]`)});
    return Boolean(row)
      && text.includes("token 20")
      && text.includes(${JSON.stringify(witnessNonce)})
      && !row.querySelector("[data-session-loading-indicator]");
  })()`, `completed witness stream in ${sessionId}`);
  const complete = Date.now() - startedAt;
  const facts = await evalIn(app, `(() => {
    const users = [...document.querySelectorAll('[data-message-role="user"]')];
    const assistants = [...document.querySelectorAll('[data-message-role="assistant"]')];
    const latestUser = users[users.length - 1];
    return {
      userLength: latestUser?.querySelector("span.whitespace-pre-wrap")?.textContent?.length ?? 0,
      assistantText: assistants[assistants.length - 1]?.innerText ?? "",
    };
  })()`);
  if (!isRecord(facts) || typeof facts.userLength !== "number" || typeof facts.assistantText !== "string") {
    throw new Error(`Could not read completed message facts: ${JSON.stringify(facts)}`);
  }
  return {
    timing: { userRendered, firstToken, complete },
    sessionId,
    assistantText: facts.assistantText,
    userLength: facts.userLength,
  };
}

async function sendMessage(app: Surface, text: string, witnessNonce: string): Promise<SendFacts> {
  const before = await readComposerState(app);
  await typeIntoComposer(app, text);
  return measurePreparedSend(app, before.userMessageCount, text, witnessNonce);
}

async function createNewSession(app: Surface): Promise<{ sessionId: string; ms: number }> {
  const previousSessionId = await evalIn(
    app,
    `document.querySelector("[data-session-surface-id]")?.getAttribute("data-session-surface-id") ?? ""`,
  );
  const previous = typeof previousSessionId === "string" ? previousSessionId : "";
  await pollExpression(app, `Boolean(document.querySelector("[data-sidebar-new-chat]"))`, "sidebar New task control");
  const startedAt = Date.now();
  const clicked = await evalIn(app, `(() => {
    const button = document.querySelector("[data-sidebar-new-chat]");
    if (!(button instanceof HTMLElement)) return false;
    button.click();
    return true;
  })()`);
  expect(clicked).toBe(true);
  const sessionId = await eventually(async () => {
    const value = await evalIn(app, `(() => {
      const match = /\\/session\\/(ses_[^/?#]+)/.exec(window.location.hash);
      return match?.[1] ?? "";
    })()`);
    return typeof value === "string" ? value : "";
  }, {
    within: 60_000,
    intervalMs: pollResolutionMs,
    label: "new session route",
    until: (value) => value.startsWith("ses_") && value !== previous,
  });
  await pollExpression(app, `(() => {
    const surface = document.querySelector("[data-session-surface-id]");
    return surface?.getAttribute("data-session-surface-id") === ${JSON.stringify(sessionId)};
  })()`, `new session surface ${sessionId}`);
  await waitForComposerReady(app, `new session ${sessionId} composer and Run task`);
  return { sessionId, ms: Date.now() - startedAt };
}

async function createSecondWorkspaceViaUi(app: Surface, firstWorkspaceId: string, workspacePath: string): Promise<string> {
  await pollExpression(
    app,
    `Boolean(document.querySelector('button[aria-label="Add workspace"]'))`,
    "Add workspace control",
  );
  const addClicked = await evalIn(app, `(() => {
    const button = document.querySelector('button[aria-label="Add workspace"]');
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  })()`);
  expect(addClicked).toBe(true);
  await pollExpression(app, `(() => [...document.querySelectorAll("button")]
    .some((button) => (button.textContent ?? "").trim().startsWith("Local workspace") && !button.disabled))()`, "Local workspace option");
  const localClicked = await evalIn(app, `(() => {
    const button = [...document.querySelectorAll("button")]
      .find((candidate) => (candidate.textContent ?? "").trim().startsWith("Local workspace") && !candidate.disabled);
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  })()`);
  expect(localClicked).toBe(true);
  await pollExpression(app, `document.body.innerText.includes("No folder selected yet.")`, "local workspace folder chooser");

  // CDP cannot operate Electron's native folder dialog. Dispatching the same
  // selected-folder reducer event used after that dialog returns keeps the rest
  // of workspace creation on the visible Add workspace flow.
  const injected = await evalIn(app, `(() => {
    const placeholder = [...document.querySelectorAll("span, div, p")]
      .find((node) => (node.textContent ?? "").includes("No folder selected yet."));
    if (!placeholder) return { ok: false, reason: "folder placeholder not found" };
    const key = Object.keys(placeholder).find((candidate) => candidate.startsWith("__reactFiber$"));
    let fiber = key ? placeholder[key] : null;
    while (fiber) {
      const componentName = fiber.elementType?.name || fiber.type?.name || "";
      if (componentName === "CreateWorkspaceModal") break;
      fiber = fiber.return;
    }
    if (!fiber) return { ok: false, reason: "CreateWorkspaceModal fiber not found" };
    let hook = fiber.memoizedState;
    while (hook) {
      if (hook.queue?.dispatch) {
        hook.queue.dispatch({ type: "set", key: "selectedFolder", value: ${JSON.stringify(workspacePath)} });
        hook.queue.dispatch({ type: "set", key: "pickingFolder", value: false });
        return { ok: true };
      }
      hook = hook.next;
    }
    return { ok: false, reason: "folder reducer dispatch not found" };
  })()`);
  if (!isRecord(injected) || injected.ok !== true) {
    throw new Error(`Could not simulate the native folder selection: ${JSON.stringify(injected)}`);
  }
  await clickButton(app, "Create Workspace", { timeoutMs: 30_000 });
  const workspaceId = await eventually(async () => {
    const value = await evalIn(app, `localStorage.getItem("openwork.react.activeWorkspace") ?? ""`);
    return typeof value === "string" ? value : "";
  }, {
    within: 120_000,
    intervalMs: pollResolutionMs,
    label: "second workspace selected from Add workspace flow",
    until: (value) => value.length > 0 && value !== firstWorkspaceId,
  });
  await pollExpression(
    app,
    `Boolean(document.querySelector(${JSON.stringify(`[data-sidebar-workspace-id="${workspaceId}"]`)}))`,
    "second workspace visible in sidebar",
  );
  await waitForComposerReady(app, "second workspace composer ready");
  return workspaceId;
}

async function clickSessionRow(app: Surface, chat: Chat): Promise<void> {
  const clicked = await evalIn(app, `(() => {
    const row = document.querySelector(${JSON.stringify(`[data-sidebar-session-id="${chat.sessionId}"][data-sidebar-session-workspace-id="${chat.workspaceId}"]`)});
    const control = row?.querySelector(${JSON.stringify(`[data-session-tab-id="${chat.sessionId}"]`)});
    if (!(row instanceof HTMLElement) || !(control instanceof HTMLElement)) return false;
    row.scrollIntoView({ block: "center" });
    control.click();
    return true;
  })()`);
  expect(clicked, `sidebar row for ${chat.title}`).toBe(true);
}

async function waitForChatSurface(app: Surface, chat: Chat): Promise<void> {
  await pollExpression(app, `(() => {
    const surface = document.querySelector("[data-session-surface-id]");
    return surface?.getAttribute("data-session-surface-id") === ${JSON.stringify(chat.sessionId)}
      && (localStorage.getItem("openwork.react.activeWorkspace") ?? "") === ${JSON.stringify(chat.workspaceId)};
  })()`, `surface for ${chat.title}`);
}

async function switchAndMeasure(app: Surface, chat: Chat): Promise<number> {
  const startedAt = Date.now();
  await clickSessionRow(app, chat);
  await waitForChatSurface(app, chat);
  await waitForComposerReady(app, `typable composer in ${chat.title}`);
  return Date.now() - startedAt;
}

async function visibleUserTexts(app: Surface): Promise<string[]> {
  const value = await evalIn(
    app,
    `[...document.querySelectorAll('[data-message-role="user"]')].map((message) => message.innerText ?? "")`,
  );
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`Visible user messages were malformed: ${JSON.stringify(value)}`);
  }
  return value;
}

function deterministicLongMessage(index: number, nonce: string): { text: string; marker: string } {
  const marker = `bench-long-${index}-${nonce}`;
  const prefix = `${marker} `;
  if (prefix.length >= longMessageChars) throw new Error("Long-message marker exceeded the benchmark payload size.");
  return { marker, text: `${prefix}${"x".repeat(longMessageChars - prefix.length)}` };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle];
  if (upper === undefined) return null;
  if (sorted.length % 2 === 1) return upper;
  const lower = sorted[middle - 1];
  return lower === undefined ? upper : (lower + upper) / 2;
}

function medianTable(results: BenchmarkResults): string {
  const rows: { scenario: string; metric: string; value: number | null }[] = [
    { scenario: "cold_boot_to_composer", metric: "appInteractive", value: median(results.cold_boot_to_composer.map((entry) => entry.appInteractive)) },
    { scenario: "cold_boot_to_composer", metric: "workspaceReady", value: median(results.cold_boot_to_composer.map((entry) => entry.workspaceReady)) },
    { scenario: "cold_boot_to_composer", metric: "composerReady", value: median(results.cold_boot_to_composer.map((entry) => entry.composerReady)) },
    { scenario: "cold_boot_to_composer", metric: "appReadinessMs", value: median(results.cold_boot_to_composer.flatMap((entry) => entry.appReadinessMs === undefined ? [] : [entry.appReadinessMs])) },
    { scenario: "first_send_cold", metric: "complete", value: median(results.first_send_cold) },
    { scenario: "new_session_ready", metric: "ready", value: median(results.new_session_ready) },
    { scenario: "message_rtt", metric: "userRendered", value: median(results.message_rtt.map((entry) => entry.userRendered)) },
    { scenario: "message_rtt", metric: "firstToken", value: median(results.message_rtt.map((entry) => entry.firstToken)) },
    { scenario: "message_rtt", metric: "complete", value: median(results.message_rtt.map((entry) => entry.complete)) },
    { scenario: "workspace_switch", metric: "aToB", value: median(results.workspace_switch.map((entry) => entry.aToB)) },
    { scenario: "workspace_switch", metric: "bToA", value: median(results.workspace_switch.map((entry) => entry.bToA)) },
    { scenario: "long_message", metric: "insertMs", value: median(results.long_message.map((entry) => entry.insertMs)) },
    { scenario: "long_message", metric: "userRendered", value: median(results.long_message.map((entry) => entry.userRendered)) },
    { scenario: "long_message", metric: "firstToken", value: median(results.long_message.map((entry) => entry.firstToken)) },
    { scenario: "long_message", metric: "complete", value: median(results.long_message.map((entry) => entry.complete)) },
  ];
  const header = "scenario                     metric             median_ms";
  return [header, ...rows.map((row) => (
    `${row.scenario.padEnd(28)} ${row.metric.padEnd(18)} ${row.value === null ? "n/a" : row.value}`
  ))].join("\n");
}

function gitCommit(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["rev-parse", "HEAD"], { cwd: import.meta.dirname, encoding: "utf8" }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout.trim());
    });
  });
}

test.skipIf(!enabled)(title, { timeout: 900_000 }, async ({ evidence }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });
  const iterations = Number(process.env.OPENWORK_BENCH_ITERATIONS ?? "1");
  expect(Number.isInteger(iterations) && iterations > 0, "OPENWORK_BENCH_ITERATIONS must be a positive integer").toBe(true);
  const runNonce = `${Date.now().toString(36)}-${process.pid}`;
  const results: BenchmarkResults = {
    cold_boot_to_composer: [],
    first_send_cold: [],
    new_session_ready: [],
    message_rtt: [],
    workspace_switch: [],
    long_message: [],
  };
  const allWitnessRequests: WitnessRequest[] = [];
  const coldWorkspaceIds: string[] = [];
  const warmupCompletions: boolean[] = [];
  const newSessionIds: string[] = [];
  const messageCompletions: boolean[] = [];
  const switchTargetChecks: boolean[] = [];
  const switchIsolationChecks: boolean[] = [];
  const longMessageChecks: boolean[] = [];
  let modelReselectedPerSession = false;
  let uiCompactionAvailable = false;
  const host = localHost();

  try {
    for (let coldIndex = 0; coldIndex < iterations; coldIndex += 1) {
      const witnessNonce = `${runNonce}-cold-${coldIndex}`;
      const witness = await startWitness(witnessNonce);
      const profileDir = await mkdtemp(join(tmpdir(), "openwork-bench-v1-profile-"));
      const workspaceAPath = await mkdtemp(join(tmpdir(), "openwork-bench-v1-workspace-a-"));
      const workspaceBPath = coldIndex === iterations - 1
        ? await mkdtemp(join(tmpdir(), "openwork-bench-v1-workspace-b-"))
        : null;
      await writeProviderConfig(workspaceAPath, witness.url);
      if (workspaceBPath) await writeProviderConfig(workspaceBPath, witness.url);
      let app: DesktopHandle | undefined;

      try {
        const appName = `bench-openwork-app-v1-${coldIndex}`;
        const timelineStart = timeline().length;
        const coldStartedAt = Date.now();
        app = await desktop({
          name: appName,
          host,
          profileDir,
          env: {
            ANTHROPIC_API_KEY: "",
            OPENAI_API_KEY: "",
            OPENROUTER_API_KEY: "",
            GOOGLE_GENERATIVE_AI_API_KEY: "",
            OPENWORK_API_KEY: "",
            OPENWORK_INFERENCE_BASE_URL: "",
          },
        });
        const appInteractive = Date.now() - coldStartedAt;
        let appReadinessMs: number | undefined;
        for (const span of timeline().slice(timelineStart)) {
          if (span.label === "app.readiness" && span.detail === appName) appReadinessMs = span.ms;
        }
        const workspaceA = await createAndSelectWorkspace(app, { path: workspaceAPath });
        coldWorkspaceIds.push(workspaceA.workspaceId);
        const workspaceReady = Date.now() - coldStartedAt;
        await waitForComposerReady(app, `cold composer ${coldIndex}`);
        const composerReady = Date.now() - coldStartedAt;
        const coldTiming: ColdTiming = {
          appInteractive,
          workspaceReady,
          composerReady,
          desktopTotalMs: appInteractive,
        };
        if (appReadinessMs !== undefined) coldTiming.appReadinessMs = appReadinessMs;
        results.cold_boot_to_composer.push(coldTiming);

        await selectBenchModel(app);
        const warmupPrompt = `bench first send cold ${coldIndex} ${witnessNonce}`;
        const warmup = await sendMessage(app, warmupPrompt, witnessNonce);
        results.first_send_cold.push(warmup.timing.complete);
        const warmupComplete = warmup.assistantText.includes(`token 20 ${witnessNonce}`)
          && warmup.userLength === warmupPrompt.length;
        warmupCompletions.push(warmupComplete);
        expect(warmupComplete).toBe(true);

        if (coldIndex === iterations - 1) {
          if (!workspaceBPath) throw new Error("Last cold instance has no second workspace directory.");
          const workspaceBId = await createSecondWorkspaceViaUi(app, workspaceA.workspaceId, workspaceBPath);
          expect(workspaceBId).not.toBe(workspaceA.workspaceId);
          await selectBenchModel(app);
          const bNonces: string[] = [];
          const setupNonce = `bench-b-setup-${witnessNonce}`;
          bNonces.push(setupNonce);
          const setup = await sendMessage(app, setupNonce, witnessNonce);
          expect(setup.assistantText).toContain(`token 20 ${witnessNonce}`);
          let latestBChat: Chat = { workspaceId: workspaceBId, sessionId: setup.sessionId, title: "workspace B setup" };
          let latestBMarker = setupNonce;

          for (let warmIndex = 0; warmIndex < iterations; warmIndex += 1) {
            const created = await createNewSession(app);
            results.new_session_ready.push(created.ms);
            newSessionIds.push(created.sessionId);
            if (await ensureBenchModel(app)) modelReselectedPerSession = true;

            const messageNonce = `${witnessNonce}-message-${warmIndex}`;
            const message = `bench message ${warmIndex} ${messageNonce}`;
            bNonces.push(messageNonce);
            const messageRun = await sendMessage(app, message, witnessNonce);
            results.message_rtt.push(messageRun.timing);
            const messageComplete = messageRun.sessionId === created.sessionId
              && messageRun.userLength === message.length
              && messageRun.assistantText.includes(`token 20 ${witnessNonce}`);
            messageCompletions.push(messageComplete);
            expect(messageComplete).toBe(true);

            await createNewSession(app);
            if (await ensureBenchModel(app)) modelReselectedPerSession = true;
            const longMessage = deterministicLongMessage(warmIndex, witnessNonce);
            bNonces.push(longMessage.marker);
            const beforeLong = await readComposerState(app);
            const insertStartedAt = Date.now();
            await typeIntoComposer(app, longMessage.text);
            const insertMs = Date.now() - insertStartedAt;
            const longRun = await measurePreparedSend(
              app,
              beforeLong.userMessageCount,
              longMessage.marker,
              witnessNonce,
            );
            results.long_message.push({ insertMs, ...longRun.timing });
            const longComplete = longRun.userLength === longMessageChars
              && longRun.assistantText.includes(`token 20 ${witnessNonce}`);
            longMessageChecks.push(longComplete);
            expect(longComplete).toBe(true);
            latestBChat = { workspaceId: workspaceBId, sessionId: longRun.sessionId, title: `workspace B long ${warmIndex}` };
            latestBMarker = longMessage.marker;
          }

          const workspaceAChat: Chat = {
            workspaceId: workspaceA.workspaceId,
            sessionId: warmup.sessionId,
            title: "workspace A warmup",
          };
          await switchAndMeasure(app, workspaceAChat);
          for (let switchIndex = 0; switchIndex < iterations; switchIndex += 1) {
            const aToB = await switchAndMeasure(app, latestBChat);
            const bTexts = await visibleUserTexts(app);
            const bTargetVisible = bTexts.some((text) => text.includes(latestBMarker));
            const bToA = await switchAndMeasure(app, workspaceAChat);
            const aTexts = await visibleUserTexts(app);
            const aIsolated = bNonces.every((nonce) => aTexts.every((text) => !text.includes(nonce)));
            results.workspace_switch.push({ aToB, bToA });
            switchTargetChecks.push(bTargetVisible);
            switchIsolationChecks.push(aIsolated);
            expect(bTargetVisible, `workspace B transcript after switch ${switchIndex}`).toBe(true);
            expect(aIsolated, `workspace A transcript after switch ${switchIndex}`).toBe(true);
          }

          const compactionProbe = await evalIn(app, `(() => {
            const root = document.querySelector("[data-session-surface-id]") ?? document;
            const controls = [...root.querySelectorAll('button, [role="menuitem"], [role="option"], [data-slot="command-item"]')];
            return controls.some((control) => {
              const label = [control.textContent, control.getAttribute("aria-label"), control.getAttribute("title")]
                .filter(Boolean)
                .join(" ")
                .toLowerCase();
              return label.includes("compact") || label.includes("summarize");
            });
          })()`);
          uiCompactionAvailable = compactionProbe === true;
        }
      } finally {
        try {
          if (app) await app.stop();
        } finally {
          await witness.close();
          allWitnessRequests.push(...witness.requests);
          await rm(profileDir, { recursive: true, force: true });
          await rm(workspaceAPath, { recursive: true, force: true });
          if (workspaceBPath) await rm(workspaceBPath, { recursive: true, force: true });
        }
      }
    }

    expect(results.cold_boot_to_composer).toHaveLength(iterations);
    expect(results.first_send_cold).toHaveLength(iterations);
    expect(new Set(coldWorkspaceIds).size).toBe(iterations);
    expect(warmupCompletions).toHaveLength(iterations);
    expect(warmupCompletions.every(Boolean)).toBe(true);
    evidence.recordAssertionEvidence(
      "Each cold v1 desktop reaches a ready composer from a fresh profile and workspace",
      `${iterations} unique workspaces reached appInteractive, workspaceReady and composerReady. No profile or workspace was reused.`,
      results.cold_boot_to_composer.length === iterations
        && new Set(coldWorkspaceIds).size === iterations,
    );
    evidence.recordAssertionEvidence(
      "Each cold v1 engine's first send completes after the untimed model selection",
      `${iterations} first sends rendered exact user messages and the final token-20 witness nonce; completion ms=${JSON.stringify(results.first_send_cold)}. No first send was incomplete.`,
      results.first_send_cold.length === iterations && warmupCompletions.every(Boolean),
    );

    expect(results.new_session_ready).toHaveLength(iterations);
    expect(new Set(newSessionIds).size).toBe(iterations);
    evidence.recordAssertionEvidence(
      "Every sidebar New task click reaches a distinct prompt-ready session",
      `${iterations} New task clicks produced ${new Set(newSessionIds).size} distinct session ids with editable composers and visible Run task controls; ms=${JSON.stringify(results.new_session_ready)}.`,
      results.new_session_ready.length === iterations && new Set(newSessionIds).size === iterations,
    );

    expect(results.message_rtt).toHaveLength(iterations);
    expect(messageCompletions).toHaveLength(iterations);
    expect(messageCompletions.every(Boolean)).toBe(true);
    evidence.recordAssertionEvidence(
      "Every regular message renders the user turn, streams the witness reply, and completes",
      `${iterations} fresh sessions rendered exact user messages and the final token-20 witness nonce with no incomplete reply; timings=${JSON.stringify(results.message_rtt)}.`,
      messageCompletions.length === iterations && messageCompletions.every(Boolean),
    );

    expect(results.workspace_switch).toHaveLength(iterations);
    expect(switchTargetChecks.every(Boolean)).toBe(true);
    expect(switchIsolationChecks.every(Boolean)).toBe(true);
    evidence.recordAssertionEvidence(
      "Cross-workspace sidebar switches restore the target transcript without leaking workspace B messages into A",
      `${iterations} A→B and B→A switches restored their target session; B's marker was present in B and every B nonce was absent from A; timings=${JSON.stringify(results.workspace_switch)}.`,
      switchTargetChecks.length === iterations
        && switchTargetChecks.every(Boolean)
        && switchIsolationChecks.length === iterations
        && switchIsolationChecks.every(Boolean),
    );

    expect(results.long_message).toHaveLength(iterations);
    expect(longMessageChecks).toHaveLength(iterations);
    expect(longMessageChecks.every(Boolean)).toBe(true);
    const longWitnessRequests = allWitnessRequests.filter((request) => request.promptChars >= longMessageChars);
    expect(longWitnessRequests.length).toBeGreaterThanOrEqual(iterations);
    evidence.recordAssertionEvidence(
      "Every 200,000-character composer message survives insertion, render, provider transport, and completion",
      `${iterations} exact-length user turns completed; witness requests with at least ${longMessageChars} prompt characters=${longWitnessRequests.length}; timings=${JSON.stringify(results.long_message)}. No long user turn was truncated.`,
      longMessageChecks.length === iterations
        && longMessageChecks.every(Boolean)
        && longWitnessRequests.length >= iterations,
    );

    expect(allWitnessRequests.length).toBeGreaterThan(0);
    const unfaithfulRequests = allWitnessRequests.filter((request) => (
      request.auth !== "Bearer bench-key-app" || request.model !== modelId
    ));
    expect(unfaithfulRequests).toEqual([]);
    evidence.recordAssertionEvidence(
      "All v1 app completions use only the file-provisioned Bench Witness model and key",
      `${allWitnessRequests.length} completion requests all carried Bearer bench-key-app and model bench-model; mismatches=${JSON.stringify(unfaithfulRequests)}. No request escaped to another configured provider.`,
      allWitnessRequests.length > 0 && unfaithfulRequests.length === 0,
    );

    const cpuList = cpus();
    const report = {
      lane: "app-v1",
      createdAt: new Date().toISOString(),
      machine: {
        platform: platform(),
        arch: arch(),
        cpus: cpuList.length,
        cpuModel: cpuList[0]?.model ?? "unknown",
        memGB: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
        node: process.version,
      },
      appCommit: await gitCommit(),
      iterations,
      pacingMs,
      tokens: tokenCount,
      pollResolutionMs,
      executionPlan: {
        coldInstances: iterations,
        warmIterations: iterations,
        warmScenariosRunIn: "last cold instance only",
      },
      modelReselectedPerSession,
      uiCompactionAvailable,
      results,
    };
    const resultsDir = process.env.OPENWORK_BENCH_RESULTS_DIR ?? tmpdir();
    await mkdir(resultsDir, { recursive: true });
    const resultsPath = join(resultsDir, `bench-openwork-app-v1-${Date.now()}.json`);
    await writeFile(resultsPath, `${JSON.stringify(report, null, 2)}\n`);
    console.info(`[bench-openwork-app-v1] medians\n${medianTable(results)}`);
    console.info(`[bench-openwork-app-v1] results=${resultsPath} uiCompactionAvailable=${uiCompactionAvailable}`);
  } finally {
    await host.stop();
  }
});
