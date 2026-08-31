import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clickButton, control, createAndSelectWorkspace, evalIn, waitFor } from "@openwork/behaviors";
import type { Surface } from "@openwork/cdp";
import { desktop } from "@openwork/hosts";
import { screenshot, validate } from "@openwork/test-evidence";
import { eventually, needs, test, unmetNeeds } from "@openwork/testkit";
import type { TestNeeds } from "@openwork/testkit";
import { expect, onTestFinished } from "vitest";

const requirements: TestNeeds = {
  optIn: ["OPENWORK_EVAL_E2E_TESTS"],
};
const missingRequirements = unmetNeeds(requirements, process.env);
const title = missingRequirements.length > 0
  ? `queued composer drain while away skipped — needs: ${missingRequirements.join(", ")}`
  : "a queued composer message drains exactly once while another workspace stays visible";

const providerId = "away-drain-mock";
const modelId = "away-drain-model";
const modelName = "Away drain model";
const firstPrompt = "away-drain first task";
const queuedPrompt = "away-drain queued follow-up";
const firstReply = "away-drain first reply";
const queuedReply = "away-drain queued reply";

type RuntimeCredentials = { port: string; token: string };
type EngineMessage = { id: string; role: string; text: string };
type MainRequest = { rawBody: string; lastUserText: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRuntimeCredentials(raw: unknown): RuntimeCredentials {
  if (typeof raw !== "string") throw new Error(`Local server credentials were not serialized: ${String(raw)}`);
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || typeof parsed.port !== "string" || typeof parsed.token !== "string") {
    throw new Error(`Invalid local server credentials: ${raw}`);
  }
  return { port: parsed.port, token: parsed.token };
}

function parseEngineMessages(payload: unknown): EngineMessage[] {
  if (!Array.isArray(payload)) throw new Error(`Engine message response is malformed: ${JSON.stringify(payload)}`);
  const messages: EngineMessage[] = [];
  for (const entry of payload) {
    if (!isRecord(entry) || !isRecord(entry.info) || typeof entry.info.id !== "string") continue;
    const parts = Array.isArray(entry.parts) ? entry.parts : [];
    messages.push({
      id: entry.info.id,
      role: typeof entry.info.role === "string" ? entry.info.role : "",
      text: parts.flatMap((part) => (
        isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []
      )).join(""),
    });
  }
  return messages;
}

async function readEngineMessages(
  credentials: RuntimeCredentials,
  workspaceId: string,
  sessionId: string,
): Promise<EngineMessage[]> {
  const response = await fetch(
    `http://127.0.0.1:${credentials.port}/workspace/${encodeURIComponent(workspaceId)}/opencode/session/${encodeURIComponent(sessionId)}/message`,
    {
      headers: { Authorization: `Bearer ${credentials.token}` },
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok) throw new Error(`Engine messages failed: ${response.status} ${(await response.text()).slice(0, 500)}`);
  return parseEngineMessages(await response.json());
}

async function waitForEngineReady(credentials: RuntimeCredentials, workspaceId: string): Promise<void> {
  await eventually(async () => {
    const response = await fetch(
      `http://127.0.0.1:${credentials.port}/workspace/${encodeURIComponent(workspaceId)}/opencode/session`,
      {
        headers: { Authorization: `Bearer ${credentials.token}` },
        signal: AbortSignal.timeout(15_000),
      },
    );
    return response.ok;
  }, {
    within: 60_000,
    intervalMs: 500,
    label: `workspace ${workspaceId} engine ready`,
    until: (ready) => ready,
  });
}

async function activeSessionId(app: Surface): Promise<string> {
  await waitFor(app, `(document.querySelector("[data-session-surface-id]")?.getAttribute("data-session-surface-id") ?? "").startsWith("ses_")`, {
    timeoutMs: 30_000,
    label: "active session surface",
  });
  const value = await evalIn(app, `document.querySelector("[data-session-surface-id]")?.getAttribute("data-session-surface-id") ?? ""`);
  if (typeof value !== "string" || !value.startsWith("ses_")) throw new Error(`Active session id was unavailable: ${String(value)}`);
  return value;
}

async function createSession(app: Surface): Promise<string> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      await control(app, "session.create_task");
      return await activeSessionId(app);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`session.create_task kept failing: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function selectMockModel(app: Surface): Promise<void> {
  await waitFor(app, `Boolean(document.querySelector('button[aria-label="Change model"]'))`, {
    timeoutMs: 60_000,
    label: "composer model selector",
  });
  const opened = await evalIn(app, `(() => {
    const trigger = document.querySelector('button[aria-label="Change model"]');
    if (!(trigger instanceof HTMLButtonElement)) return false;
    trigger.click();
    return true;
  })()`);
  expect(opened).toBe(true);
  await waitFor(app, `(() => {
    const popover = document.querySelector('[data-slot="popover-content"]');
    return popover instanceof HTMLElement
      && popover.querySelector('[data-slot="model-select-root"]') instanceof HTMLElement;
  })()`, { timeoutMs: 60_000, label: "model picker root pane" });
  const modelPaneOpened = await evalIn(app, `(() => {
    const root = document.querySelector('[data-slot="popover-content"] [data-slot="model-select-root"]');
    const button = [...(root?.querySelectorAll("button") ?? [])]
      .find((candidate) => candidate.querySelector("span")?.textContent?.trim() === "Model");
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  })()`);
  expect(modelPaneOpened).toBe(true);
  await waitFor(app, `(() => {
    const input = document.querySelector('[data-slot="popover-content"] input[placeholder="Search models..."]');
    return input instanceof HTMLInputElement;
  })()`, { timeoutMs: 60_000, label: "model picker search input" });
  const searchFocused = await evalIn(app, `(() => {
    const input = document.querySelector('[data-slot="popover-content"] input[placeholder="Search models..."]');
    if (!(input instanceof HTMLInputElement)) return false;
    input.focus();
    return true;
  })()`);
  expect(searchFocused).toBe(true);
  await app.client.send("Input.insertText", { text: modelName });
  await waitFor(app, `(() => {
    const popover = document.querySelector('[data-slot="popover-content"]');
    const input = popover?.querySelector('input[placeholder="Search models..."]');
    return input instanceof HTMLInputElement
      && input.value === ${JSON.stringify(modelName)}
      && [...popover.querySelectorAll('[data-slot="command-item"]')]
        .some((item) => (item.textContent ?? "").includes(${JSON.stringify(modelName)}));
  })()`, { timeoutMs: 60_000, label: "away drain mock model listed after search" });
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
    label: "away drain mock model selected",
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

async function pressEnter(app: Surface): Promise<void> {
  await app.client.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
    text: "\r",
    unmodifiedText: "\r",
  });
  await app.client.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
}

async function clickSessionRow(app: Surface, workspaceId: string, sessionId: string): Promise<void> {
  const clicked = await evalIn(app, `(() => {
    const row = document.querySelector(${JSON.stringify(`[data-sidebar-session-id="${sessionId}"][data-sidebar-session-workspace-id="${workspaceId}"]`)});
    const tab = row?.querySelector(${JSON.stringify(`[data-session-tab-id="${sessionId}"]`)});
    if (!(row instanceof HTMLElement) || !(tab instanceof HTMLElement)) return false;
    row.scrollIntoView({ block: "center" });
    tab.click();
    return true;
  })()`);
  expect(clicked).toBe(true);
  await waitFor(app, `(() => {
    const surface = document.querySelector("[data-session-surface-id]");
    return surface?.getAttribute("data-session-surface-id") === ${JSON.stringify(sessionId)}
      && (localStorage.getItem("openwork.react.activeWorkspace") ?? "") === ${JSON.stringify(workspaceId)};
  })()`, { timeoutMs: 60_000, label: `workspace ${workspaceId} session ${sessionId} visible` });
}

function lastUserTextFromBody(rawBody: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return "";
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.messages)) return "";
  for (let index = parsed.messages.length - 1; index >= 0; index -= 1) {
    const message: unknown = parsed.messages[index];
    if (!isRecord(message) || message.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) {
      return message.content.flatMap((part) => (
        isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []
      )).join("");
    }
    return "";
  }
  return "";
}

async function writeWorkspaceConfig(workspacePath: string, baseUrl: string): Promise<void> {
  await writeFile(join(workspacePath, "opencode.json"), `${JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    provider: {
      [providerId]: {
        npm: "@ai-sdk/openai-compatible",
        name: "Away drain mock",
        options: { baseURL: baseUrl, apiKey: "sk-away-drain" },
        models: { [modelId]: { name: modelName } },
      },
    },
  }, null, 2)}\n`);
}

test(title, async ({ evidence }) => {
  needs(requirements);

  const mainRequests: MainRequest[] = [];
  let releaseFirst: () => void = () => undefined;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const mock = createServer((request, response) => {
    const url = request.url ?? "";
    if (request.method === "GET" && url.startsWith("/v1/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: modelId, object: "model" }] }));
      return;
    }
    if (request.method === "POST" && (url === "/v1/chat/completions" || url === "/chat/completions")) {
      request.setEncoding("utf8");
      let rawBody = "";
      request.on("data", (chunk: string) => {
        rawBody += chunk;
      });
      request.on("end", () => {
        let parsedBody: unknown;
        try {
          parsedBody = JSON.parse(rawBody);
        } catch {
          parsedBody = null;
        }
        const tools = isRecord(parsedBody) ? parsedBody.tools : undefined;
        const isMain = Array.isArray(tools) && tools.length > 0;
        if (isMain) mainRequests.push({ rawBody, lastUserText: lastUserTextFromBody(rawBody) });
        const reply = !isMain ? "Away drain session title" : rawBody.includes(queuedPrompt) ? queuedReply : firstReply;
        const id = `chatcmpl-away-drain-${mainRequests.length}`;
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
          write({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: reply }, finish_reason: null }] });
          setTimeout(() => {
            write({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
            setTimeout(() => {
              if (!response.writableEnded) response.end("data: [DONE]\n\n");
            }, 200);
          }, 200);
        };
        if (isMain && !rawBody.includes(queuedPrompt)) {
          void firstGate.then(finish);
          return;
        }
        setTimeout(finish, 200);
      });
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "not found" } }));
  });
  await new Promise<void>((resolve, reject) => {
    mock.once("error", reject);
    mock.listen(0, "127.0.0.1", resolve);
  });
  onTestFinished(async () => {
    releaseFirst();
    mock.closeAllConnections();
    await new Promise<void>((resolve, reject) => mock.close((error) => error ? reject(error) : resolve()));
  });
  const address = mock.address();
  if (!address || typeof address === "string") throw new Error("Mock provider did not bind a TCP port.");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;

  await using app = await desktop({
    name: "queued-drain-while-away",
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

  const workspacePathA = await mkdtemp(join(tmpdir(), "openwork-away-drain-a-"));
  const workspacePathB = await mkdtemp(join(tmpdir(), "openwork-away-drain-b-"));
  await Promise.all([
    writeWorkspaceConfig(workspacePathA, baseUrl),
    writeWorkspaceConfig(workspacePathB, baseUrl),
  ]);

  const workspaceA = await createAndSelectWorkspace(app, { path: workspacePathA });
  const credentials = parseRuntimeCredentials(await evalIn(app, `JSON.stringify({
    port: localStorage.getItem("openwork.server.port") ?? "",
    token: localStorage.getItem("openwork.server.token") ?? "",
  })`));
  await waitForEngineReady(credentials, workspaceA.workspaceId);
  const sessionA = await createSession(app);
  await selectMockModel(app);
  await typeIntoComposer(app, firstPrompt);
  await clickButton(app, "Run task", { timeoutMs: 30_000 });
  const firstRequestCount = await eventually(() => mainRequests.length, {
    within: 60_000,
    intervalMs: 200,
    label: "first gated completion reached mock",
    until: (count) => count === 1,
  });
  expect(firstRequestCount).toBe(1);
  expect(mainRequests[0]?.lastUserText).toContain(firstPrompt);
  await waitFor(app, `Boolean(document.querySelector('button[aria-label="Stop"]'))`, {
    timeoutMs: 60_000,
    label: "session A is busy",
  });

  await typeIntoComposer(app, queuedPrompt);
  expect(await evalIn(app, `Boolean(document.querySelector('button[aria-label="Stop"]'))`)).toBe(true);
  await pressEnter(app);
  await waitFor(app, `document.body.innerText.includes("1 queued")`, {
    timeoutMs: 15_000,
    label: "follow-up queued in session A",
  });
  const queuedUiState = await evalIn(app, `(() => ({
    badge: document.body.innerText.includes("1 queued"),
    queuedUserBubble: [...document.querySelectorAll('[data-message-role="user"]')]
      .some((bubble) => (bubble.textContent ?? "").includes(${JSON.stringify(queuedPrompt)})),
  }))()`);
  expect(queuedUiState).toEqual({ badge: true, queuedUserBubble: false });
  const engineWhileBusy = await readEngineMessages(credentials, workspaceA.workspaceId, sessionA);
  expect(engineWhileBusy.some((message) => message.text.includes(queuedPrompt))).toBe(false);
  expect(mainRequests.filter((request) => request.rawBody.includes(queuedPrompt))).toHaveLength(0);
  {
    const shot = await screenshot(app);
    const seen = await validate(shot, [
      "The busy conversation shows a queued messages panel headed '1 queued'",
      "The queued follow-up is not rendered as a user conversation bubble",
      "No error dialog or crash is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
  }
  evidence.recordAssertionEvidence(
    "A follow-up remains queued and unsent while session A is busy",
    `Session ${sessionA} showed "1 queued" with no queued-text user bubble; its engine had ${engineWhileBusy.length} messages, none containing the queued marker, and the mock had zero requests containing it.`,
    true,
  );

  const workspaceB = await createAndSelectWorkspace(app, { path: workspacePathB });
  await waitForEngineReady(credentials, workspaceB.workspaceId);
  const sessionB = await createSession(app);
  expect(sessionB).not.toBe(sessionA);
  const awayState = await evalIn(app, `(() => ({
    active: document.querySelector("[data-session-surface-id]")?.getAttribute("data-session-surface-id") ?? "",
    sessionASurfacePresent: Boolean(document.querySelector(${JSON.stringify(`[data-session-surface-id="${sessionA}"]`)})),
    workspace: localStorage.getItem("openwork.react.activeWorkspace") ?? "",
  }))()`);
  expect(awayState).toEqual({ active: sessionB, sessionASurfacePresent: false, workspace: workspaceB.workspaceId });
  const bBeforeDrain = await readEngineMessages(credentials, workspaceB.workspaceId, sessionB);
  expect(bBeforeDrain.some((message) => message.text.includes(queuedPrompt))).toBe(false);
  {
    const shot = await screenshot(app);
    const seen = await validate(shot, [
      "An empty session with no conversation messages is visible",
      "The text '1 queued' is not visible anywhere",
      "No message bubble contains 'away-drain queued follow-up'",
      "No error dialog or crash is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
  }

  releaseFirst();
  const drained = await eventually(async () => {
    const [aMessages, bMessages] = await Promise.all([
      readEngineMessages(credentials, workspaceA.workspaceId, sessionA),
      readEngineMessages(credentials, workspaceB.workspaceId, sessionB),
    ]);
    const visibleSession = await evalIn(app, `document.querySelector("[data-session-surface-id]")?.getAttribute("data-session-surface-id") ?? ""`);
    return { aMessages, bMessages, visibleSession };
  }, {
    within: 60_000,
    intervalMs: 250,
    label: "session A queued follow-up drains while session B remains visible",
    until: ({ aMessages, bMessages, visibleSession }) => aMessages.length === 4
      && aMessages.some((message) => message.role === "assistant" && message.text === queuedReply)
      && !bMessages.some((message) => message.text.includes(queuedPrompt))
      && visibleSession === sessionB,
  });
  expect(drained.visibleSession).toBe(sessionB);
  expect(drained.bMessages.some((message) => message.text.includes(queuedPrompt))).toBe(false);
  expect(drained.aMessages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
  expect(drained.aMessages[0]?.text).toContain(firstPrompt);
  expect(drained.aMessages[1]?.text).toBe(firstReply);
  expect(drained.aMessages[2]?.text.trim()).toBe(queuedPrompt);
  expect(drained.aMessages[3]?.text).toBe(queuedReply);
  const queuedRequestsAfterDrain = mainRequests.filter((request) => request.rawBody.includes(queuedPrompt));
  expect(queuedRequestsAfterDrain).toHaveLength(1);
  expect(queuedRequestsAfterDrain[0]?.lastUserText.trim()).toBe(queuedPrompt);
  {
    const shot = await screenshot(app);
    const seen = await validate(shot, [
      "An empty conversation with no message bubbles is visible",
      "The text '1 queued' is not visible anywhere",
      "No message bubble contains 'away-drain queued follow-up'",
      "No error dialog or crash is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
  }
  evidence.recordAssertionEvidence(
    "Session A drains the queued follow-up exactly once while session B stays visible and clean",
    `While visible session remained ${sessionB}, session A gained a separate user turn after its first assistant reply; session B had ${drained.bMessages.length} messages containing no queued marker, and exactly ${queuedRequestsAfterDrain.length} main provider request contained it.`,
    true,
  );

  await clickSessionRow(app, workspaceA.workspaceId, sessionA);
  await waitFor(app, `(() => {
    const bubbles = [...document.querySelectorAll('[data-message-role="user"]')];
    return bubbles.some((bubble) => (bubble.textContent ?? "").includes(${JSON.stringify(queuedPrompt)}))
      && !document.body.innerText.includes("1 queued");
  })()`, { timeoutMs: 30_000, label: "drained follow-up reconciled after returning to session A" });
  const returnUi = await evalIn(app, `(() => ({
    queuedBadge: document.body.innerText.includes("1 queued"),
    queuedBubbleCount: [...document.querySelectorAll('[data-message-role="user"]')]
      .filter((bubble) => (bubble.textContent ?? "").includes(${JSON.stringify(queuedPrompt)})).length,
  }))()`);
  expect(returnUi).toEqual({ queuedBadge: false, queuedBubbleCount: 1 });
  expect(mainRequests.filter((request) => request.rawBody.includes(queuedPrompt))).toHaveLength(1);
  const bAfterReturn = await readEngineMessages(credentials, workspaceB.workspaceId, sessionB);
  expect(bAfterReturn.some((message) => message.text.includes(queuedPrompt))).toBe(false);
  {
    const shot = await screenshot(app);
    const seen = await validate(shot, [
      "A user message bubble containing 'away-drain queued follow-up' is visible",
      "The text '1 queued' is not visible anywhere",
      "No error dialog or crash is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
  }
  evidence.recordAssertionEvidence(
    "Returning to session A reconciles the drained turn without sending it again",
    `The queued badge was absent, exactly one rendered user bubble contained the queued marker, the mock still had exactly one matching main request after remount, and session B remained clean.`,
    true,
  );
});
