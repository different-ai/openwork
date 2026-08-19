import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, onTestFinished } from "vitest";
import { clickButton, control, createAndSelectWorkspace, evalIn, waitFor } from "@openwork/behaviors";
import type { Surface } from "@openwork/cdp";
import { screenshot, validate } from "@openwork/test-evidence";
import { desktop } from "@openwork/hosts";
import { needs, test, unmetNeeds } from "@openwork/testkit";
import type { TestNeeds } from "@openwork/testkit";

const requirements: TestNeeds = {
  optIn: ["OPENWORK_EVAL_E2E_TESTS"],
};
const missingRequirements = unmetNeeds(requirements, process.env);
const title = missingRequirements.length > 0
  ? `sequential queued follow-ups skipped — needs: ${missingRequirements.join(", ")}`
  : "queued follow-ups drain as separate FIFO user turns, never one merged message";

const providerId = "sequential-queue-mock";
const modelId = "sequential-queue-model";
const firstPrompt = "Start the long deterministic task for sequential queue proof.";
const queuedPromptOne = "Queued follow-up ONE for sequential drain proof.";
const queuedPromptTwo = "Queued follow-up TWO for sequential drain proof.";
const replies = [
  "Deterministic long-task reply.",
  "Deterministic drain-one reply.",
  "Deterministic drain-two reply.",
] as const;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type RuntimeCredentials = { port: string; token: string };
type EngineMessage = { id: string; role: string; text: string };
type EngineSnapshot = { sessionId: string; messages: EngineMessage[] };
type MainRequestLabel = "first" | "one" | "two" | "unexpected";
type MainRequest = { label: MainRequestLabel; lastUserText: string };

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

function parseEngineSnapshot(payload: unknown): EngineSnapshot {
  if (!isRecord(payload) || !isRecord(payload.item)) throw new Error("Session snapshot response has no item.");
  const item = payload.item;
  if (!isRecord(item.session) || typeof item.session.id !== "string" || !Array.isArray(item.messages)) {
    throw new Error("Session snapshot item is malformed.");
  }
  const messages: EngineMessage[] = [];
  for (const entry of item.messages) {
    if (!isRecord(entry) || !isRecord(entry.info) || typeof entry.info.id !== "string") continue;
    const parts = Array.isArray(entry.parts) ? entry.parts : [];
    const text = parts.flatMap((part) => (
      isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []
    )).join("");
    messages.push({
      id: entry.info.id,
      role: typeof entry.info.role === "string" ? entry.info.role : "",
      text,
    });
  }
  return { sessionId: item.session.id, messages };
}

async function readEngineSnapshot(
  credentials: RuntimeCredentials,
  workspaceId: string,
  sessionId: string,
): Promise<EngineSnapshot> {
  const response = await fetch(
    `http://127.0.0.1:${credentials.port}/workspace/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/snapshot`,
    { headers: { Authorization: `Bearer ${credentials.token}` }, signal: AbortSignal.timeout(15_000) },
  );
  if (!response.ok) throw new Error(`Snapshot failed: ${response.status} ${(await response.text()).slice(0, 500)}`);
  const payload: unknown = await response.json();
  return parseEngineSnapshot(payload);
}

async function waitForEngineSnapshot(
  credentials: RuntimeCredentials,
  workspaceId: string,
  sessionId: string,
  label: string,
  predicate: (snapshot: EngineSnapshot) => boolean,
): Promise<EngineSnapshot> {
  const deadline = Date.now() + 60_000;
  let latest: EngineSnapshot | null = null;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      latest = await readEngineSnapshot(credentials, workspaceId, sessionId);
      if (predicate(latest)) return latest;
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  const failure = lastError instanceof Error ? ` lastError=${lastError.message}` : "";
  throw new Error(`${label} did not converge; latest=${JSON.stringify(latest)}${failure}`);
}

async function waitForEngineReady(
  credentials: RuntimeCredentials,
  workspaceId: string,
): Promise<void> {
  const deadline = Date.now() + 60_000;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(
        `http://127.0.0.1:${credentials.port}/workspace/${encodeURIComponent(workspaceId)}/opencode/session`,
        { headers: { Authorization: `Bearer ${credentials.token}` }, signal: AbortSignal.timeout(15_000) },
      );
      if (response.ok) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(500);
  }
  throw new Error(`Engine did not become ready after reload; last=${last}`);
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

// Plain Enter on the Lexical composer: while the agent is busy this must
// queue (Cmd/Ctrl+Enter is the steer modifier, deliberately not sent here).
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

async function waitForReply(app: Surface, reply: string): Promise<void> {
  await waitFor(app, `[...document.querySelectorAll('[data-message-role="assistant"]')]
    .some((message) => message.textContent?.includes(${JSON.stringify(reply)}))`, {
    timeoutMs: 120_000,
    label: `assistant reply ${reply}`,
  });
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
    const content = message.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content.flatMap((part) => (
        isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []
      )).join("");
    }
    return "";
  }
  return "";
}

test(title, async ({ evidence }) => {
  needs(requirements);

  // Deterministic OpenAI-compatible provider. The conversation grows
  // monotonically, so replies key off the newest prompt first. Utility
  // requests (session titles) carry no tools array and never count as main
  // completions. The first two main completions are HELD OPEN until the
  // runner releases them, so the busy windows last exactly as long as the
  // queue interactions and mid-drain assertions need — no timing races.
  const mainRequests: MainRequest[] = [];
  const releases: Record<"first" | "one", { promise: Promise<void>; release: () => void }> = (() => {
    const gate = (): { promise: Promise<void>; release: () => void } => {
      let release: () => void = () => undefined;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { promise, release };
    };
    return { first: gate(), one: gate() };
  })();
  const classify = (rawBody: string): MainRequestLabel => {
    if (rawBody.includes(queuedPromptTwo)) return "two";
    if (rawBody.includes(queuedPromptOne)) return "one";
    if (rawBody.includes(firstPrompt)) return "first";
    return "unexpected";
  };
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
        const label = classify(rawBody);
        let reply = "Session title";
        if (isMain) {
          mainRequests.push({ label, lastUserText: lastUserTextFromBody(rawBody) });
          reply = label === "unexpected"
            ? `Unexpected completion for: ${rawBody.slice(0, 200)}`
            : label === "first" ? replies[0] : label === "one" ? replies[1] : replies[2];
        }
        const id = `chatcmpl-sequential-queue-${mainRequests.length}`;
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
            }, 300);
          }, 300);
        };
        if (isMain && (label === "first" || label === "one")) {
          void releases[label].promise.then(finish);
          return;
        }
        setTimeout(finish, 400);
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
    // Release any still-gated completions and drop held SSE connections so a
    // failed run cannot hang server close.
    releases.first.release();
    releases.one.release();
    mock.closeAllConnections();
    await new Promise<void>((resolve, reject) => mock.close((error) => error ? reject(error) : resolve()));
  });
  const address = mock.address();
  if (!address || typeof address === "string") throw new Error("Mock provider did not bind a TCP port.");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;

  await using app = await desktop({
    name: "sequential-queue",
    mode: process.env.OPENWORK_EVAL_CDP_URL?.trim() ? "attach" : "spawn",
    // Provider keys in the runner env (e.g. via infisical) would make the
    // engine register real providers and out-default the deterministic mock.
    env: {
      ANTHROPIC_API_KEY: "",
      OPENAI_API_KEY: "",
      OPENROUTER_API_KEY: "",
      GOOGLE_GENERATIVE_AI_API_KEY: "",
      OPENWORK_API_KEY: "",
      OPENWORK_INFERENCE_BASE_URL: "",
    },
  });
  // Register the deterministic provider through the workspace's own
  // opencode.json BEFORE the workspace is added. The engine reads it at
  // spawn, so no config PATCH, engine reload, or renderer reload is needed —
  // reloading mid-session detaches the renderer's engine event stream and
  // would starve the live busy status this spec asserts on.
  const workspacePath = `/tmp/openwork-sequential-queue-${Date.now()}`;
  await mkdir(workspacePath, { recursive: true });
  await writeFile(join(workspacePath, "opencode.json"), `${JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    provider: {
      [providerId]: {
        npm: "@ai-sdk/openai-compatible",
        name: "Sequential queue mock",
        options: { baseURL: baseUrl, apiKey: "sk-sequential-queue" },
        models: { [modelId]: { name: "Sequential queue model" } },
      },
    },
  }, null, 2)}\n`);
  const workspace = await createAndSelectWorkspace(app, { path: workspacePath });
  const credentials = parseRuntimeCredentials(await evalIn(app, `JSON.stringify({
    port: localStorage.getItem("openwork.server.port") ?? "",
    token: localStorage.getItem("openwork.server.token") ?? "",
  })`));
  await waitForEngineReady(credentials, workspace.workspaceId);
  await waitFor(app, `window.__openworkControl.listActions().some((action) => action.id === "session.create_task" && !action.disabled)`, {
    timeoutMs: 30_000,
    label: "new task action enabled",
  });
  // Right after the reload the route can briefly report the action enabled
  // while its workspace endpoints are still hydrating, and task creation
  // returns null. Retry like a user re-clicking New task.
  {
    const deadline = Date.now() + 30_000;
    let created = false;
    let lastError: unknown = null;
    while (!created && Date.now() < deadline) {
      try {
        await control(app, "session.create_task");
        created = true;
      } catch (error) {
        lastError = error;
        await sleep(500);
      }
    }
    if (!created) {
      throw new Error(`session.create_task kept failing after reload: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
    }
  }

  // Select the deterministic mock model the way a user would: through the
  // compact model picker. This keeps the whole flow on the untouched boot
  // path, whose live engine event stream drives the busy composer state.
  await waitFor(app, `Boolean(document.querySelector('button[aria-label="Change model"]'))`, {
    timeoutMs: 60_000,
    label: "composer model selector",
  });
  const pickerOpened = await evalIn(app, `(() => {
    const trigger = document.querySelector('button[aria-label="Change model"]');
    if (!(trigger instanceof HTMLButtonElement)) return false;
    trigger.click();
    return true;
  })()`);
  expect(pickerOpened).toBe(true);
  await waitFor(app, `(() => {
    const popover = document.querySelector('[data-slot="popover-content"]');
    if (!(popover instanceof HTMLElement)) return false;
    return [...popover.querySelectorAll('[data-slot="command-item"]')]
      .some((item) => (item.textContent ?? "").includes("Sequential queue model"));
  })()`, { timeoutMs: 60_000, label: "mock model listed in the picker" });
  const modelPicked = await evalIn(app, `(() => {
    const popover = document.querySelector('[data-slot="popover-content"]');
    const item = [...(popover?.querySelectorAll('[data-slot="command-item"]') ?? [])]
      .find((candidate) => (candidate.textContent ?? "").includes("Sequential queue model"));
    if (!(item instanceof HTMLElement)) return false;
    item.click();
    return true;
  })()`);
  expect(modelPicked).toBe(true);
  await waitFor(app, `(document.querySelector('button[aria-label="Change model"]')?.textContent ?? "").includes("Sequential queue model")`, {
    timeoutMs: 15_000,
    label: "mock model selected for the session",
  });

  await typeIntoComposer(app, firstPrompt);
  await clickButton(app, "Run task", { timeoutMs: 30_000 });
  const sessionId = await activeSessionId(app);

  // Anchor on the mock actually serving the first main completion. The mock
  // holds this completion open until the runner releases it, so from here the
  // session is deterministically busy for as long as the queue interactions
  // need. If this times out the engine never used the deterministic mock, so
  // surface what the session shows instead.
  {
    const deadline = Date.now() + 60_000;
    while (mainRequests.length === 0 && Date.now() < deadline) await sleep(200);
    if (mainRequests.length === 0) {
      const bodyText = await evalIn(app, "document.body.innerText.slice(0, 2000)");
      throw new Error(`The mock provider never received a main completion for the first prompt. On screen: ${String(bodyText)}`);
    }
    expect(mainRequests[0]?.label).toBe("first");
  }

  // Claim 1 — busy affordance: the idle round send control becomes one round
  // Stop control in the same slot, with no Run task button and no legacy
  // Steer | queue split while the run is busy.
  await waitFor(app, `Boolean(document.querySelector('button[aria-label="Stop"]'))`, {
    timeoutMs: 90_000,
    label: "busy composer shows the round stop control",
  });
  const busyControls = await evalIn(app, `(() => ({
    stopButtons: document.querySelectorAll('button[aria-label="Stop"]').length,
    runTaskButton: Boolean(document.querySelector('button[aria-label="Run task"]')),
    queueSplitButton: Boolean(document.querySelector('button[aria-label="Send when agent finishes"]')),
    steerSplitButton: [...document.querySelectorAll("button")]
      .some((button) => (button.getAttribute("title") ?? "") === "Send now — the agent will adjust mid-task"),
  }))()`);
  expect(busyControls).toEqual({
    stopButtons: 1,
    runTaskButton: false,
    queueSplitButton: false,
    steerSplitButton: false,
  });
  evidence.recordAssertionEvidence(
    "While the agent is busy the composer offers exactly one round Stop control",
    `Busy control census: ${JSON.stringify(busyControls)} — one Stop button, no Run task button, no legacy Steer/queue split.`,
    isRecord(busyControls)
      && busyControls.stopButtons === 1
      && busyControls.runTaskButton === false
      && busyControls.queueSplitButton === false
      && busyControls.steerSplitButton === false,
  );

  // Claim 2 — plain Enter while busy queues instead of sending: two queued
  // follow-ups stack FIFO in the queued panel while the provider has seen
  // exactly one main completion and the engine exactly one user turn.
  await typeIntoComposer(app, queuedPromptOne);
  const busyBeforeFirstEnter = await evalIn(app, `Boolean(document.querySelector('button[aria-label="Stop"]'))`);
  expect(busyBeforeFirstEnter).toBe(true);
  await pressEnter(app);
  await waitFor(app, `document.body.innerText.includes("1 queued")`, {
    timeoutMs: 15_000,
    label: "first follow-up queued",
  });
  await typeIntoComposer(app, queuedPromptTwo);
  const busyBeforeSecondEnter = await evalIn(app, `Boolean(document.querySelector('button[aria-label="Stop"]'))`);
  expect(busyBeforeSecondEnter).toBe(true);
  await pressEnter(app);
  await waitFor(app, `document.body.innerText.includes("2 queued")`, {
    timeoutMs: 15_000,
    label: "second follow-up queued",
  });
  const queuedState = await evalIn(app, `(() => {
    const body = document.body.innerText;
    const userBubbles = [...document.querySelectorAll('[data-message-role="user"]')]
      .map((bubble) => bubble.textContent ?? "");
    return {
      firstIndex: body.indexOf(${JSON.stringify(queuedPromptOne)}),
      secondIndex: body.indexOf(${JSON.stringify(queuedPromptTwo)}),
      queuedHeader: body.includes("2 queued"),
      userBubbleWithQueuedText: userBubbles.some((text) =>
        text.includes(${JSON.stringify(queuedPromptOne)}) || text.includes(${JSON.stringify(queuedPromptTwo)})),
    };
  })()`);
  if (!isRecord(queuedState)
    || typeof queuedState.firstIndex !== "number"
    || typeof queuedState.secondIndex !== "number") {
    throw new Error(`Queued panel state unavailable: ${JSON.stringify(queuedState)}`);
  }
  expect(queuedState.queuedHeader).toBe(true);
  expect(queuedState.firstIndex).toBeGreaterThanOrEqual(0);
  expect(queuedState.secondIndex).toBeGreaterThan(queuedState.firstIndex);
  expect(queuedState.userBubbleWithQueuedText).toBe(false);
  const engineWhileQueued = await readEngineSnapshot(credentials, workspace.workspaceId, sessionId);
  const userTurnsWhileQueued = engineWhileQueued.messages.filter((message) => message.role === "user");
  expect(userTurnsWhileQueued.length).toBe(1);
  expect(engineWhileQueued.messages.some((message) =>
    message.text.includes(queuedPromptOne) || message.text.includes(queuedPromptTwo))).toBe(false);
  expect(mainRequests.length).toBe(1);
  expect(mainRequests[0]?.label).toBe("first");
  {
    const shot = await screenshot(app);
    const seen = await validate(shot, [
      "A queued messages panel headed '2 queued' lists two queued follow-up messages",
      "The composer's round action button shows a stop control (filled square icon), not an upward send arrow",
      "No error dialog or crash is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
  }
  evidence.recordAssertionEvidence(
    "Plain Enter while busy queues follow-ups FIFO instead of sending them",
    `With the run still busy, both follow-ups sat in the queued panel in submission order ("2 queued", first at index ${queuedState.firstIndex} before second at ${queuedState.secondIndex}), no user bubble contained them, the engine held exactly ${userTurnsWhileQueued.length} user turn, and the provider had served exactly ${mainRequests.length} main completion.`,
    queuedState.queuedHeader === true
      && queuedState.firstIndex >= 0
      && queuedState.secondIndex > queuedState.firstIndex
      && queuedState.userBubbleWithQueuedText === false
      && userTurnsWhileQueued.length === 1
      && mainRequests.length === 1,
  );

  // Claim 3 — idle drains only the FIRST queued item as its own user turn;
  // the second stays queued until the drained turn's run finishes. The mock
  // holds the drained turn's completion open, so this intermediate state is
  // frozen while it is asserted.
  releases.first.release();
  await waitForReply(app, replies[0]);
  await waitFor(app, `(() => {
    const body = document.body.innerText;
    const userBubbles = [...document.querySelectorAll('[data-message-role="user"]')]
      .map((bubble) => bubble.textContent ?? "");
    return body.includes("1 queued")
      && userBubbles.some((text) => text.includes(${JSON.stringify(queuedPromptOne)}))
      && !userBubbles.some((text) => text.includes(${JSON.stringify(queuedPromptTwo)}));
  })()`, { timeoutMs: 60_000, label: "first queued item drained alone, second still queued" });
  // The drained turn must be visibly busy again (round Stop control) before
  // its reply is released: the sequential contract waits for busy before the
  // next idle may drain the second item.
  await waitFor(app, `Boolean(document.querySelector('button[aria-label="Stop"]'))`, {
    timeoutMs: 90_000,
    label: "drained turn is busy in the composer",
  });
  expect(mainRequests.length).toBe(2);
  expect(mainRequests[1]?.label).toBe("one");
  const drainOneUserText = mainRequests[1]?.lastUserText ?? "";
  expect(drainOneUserText.includes(queuedPromptOne)).toBe(true);
  expect(drainOneUserText.includes(queuedPromptTwo)).toBe(false);
  expect(drainOneUserText.includes(firstPrompt)).toBe(false);
  {
    const shot = await screenshot(app);
    const seen = await validate(shot, [
      "The conversation shows a user message reading 'Queued follow-up ONE for sequential drain proof.'",
      "A queued messages panel headed '1 queued' still holds the second follow-up",
      "No error dialog or crash is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
  }
  evidence.recordAssertionEvidence(
    "The idle drain sends only the first queued item as its own turn",
    `After the busy run finished, the transcript gained the first follow-up as its own user turn while "1 queued" still held the second; the provider's second main completion carried exactly the first follow-up as its newest user message (contains second follow-up: ${drainOneUserText.includes(queuedPromptTwo)}, contains initial prompt: ${drainOneUserText.includes(firstPrompt)}).`,
    mainRequests.length === 2
      && mainRequests[1]?.label === "one"
      && drainOneUserText.includes(queuedPromptOne)
      && !drainOneUserText.includes(queuedPromptTwo)
      && !drainOneUserText.includes(firstPrompt),
  );

  // Claim 4 — the second item drains after the first turn's run completes:
  // the final transcript is three separate FIFO user turns, never merged.
  releases.one.release();
  await waitForReply(app, replies[1]);
  await waitForReply(app, replies[2]);
  await waitFor(app, `!/\\b\\d+ queued\\b/.test(document.body.innerText)`, {
    timeoutMs: 30_000,
    label: "queued panel emptied",
  });
  const finalSnapshot = await waitForEngineSnapshot(
    credentials,
    workspace.workspaceId,
    sessionId,
    "final six-message transcript",
    (snapshot) => snapshot.messages.length === 6
      && snapshot.messages.some((message) => message.text === replies[2]),
  );
  expect(finalSnapshot.messages.map((message) => message.role))
    .toEqual(["user", "assistant", "user", "assistant", "user", "assistant"]);
  const [turnOne, replyOne, turnTwo, replyTwo, turnThree, replyThree] = finalSnapshot.messages;
  expect(turnOne?.text.includes(firstPrompt)).toBe(true);
  expect(turnOne?.text.includes(queuedPromptOne)).toBe(false);
  expect(turnOne?.text.includes(queuedPromptTwo)).toBe(false);
  expect(replyOne?.text).toBe(replies[0]);
  expect(turnTwo?.text.trim()).toBe(queuedPromptOne);
  expect(replyTwo?.text).toBe(replies[1]);
  expect(turnThree?.text.trim()).toBe(queuedPromptTwo);
  expect(replyThree?.text).toBe(replies[2]);
  const mergedMessages = finalSnapshot.messages.filter((message) =>
    message.text.includes(queuedPromptOne) && message.text.includes(queuedPromptTwo));
  expect(mergedMessages).toEqual([]);
  expect(mainRequests.map((request) => request.label)).toEqual(["first", "one", "two"]);
  const drainTwoUserText = mainRequests[2]?.lastUserText ?? "";
  expect(drainTwoUserText.trim()).toBe(queuedPromptTwo);
  const finalBubbles = await evalIn(app, `(() => {
    const userBubbles = [...document.querySelectorAll('[data-message-role="user"]')]
      .map((bubble) => bubble.textContent ?? "");
    return {
      withFirstQueued: userBubbles.filter((text) => text.includes(${JSON.stringify(queuedPromptOne)})).length,
      withSecondQueued: userBubbles.filter((text) => text.includes(${JSON.stringify(queuedPromptTwo)})).length,
      withBoth: userBubbles.filter((text) =>
        text.includes(${JSON.stringify(queuedPromptOne)}) && text.includes(${JSON.stringify(queuedPromptTwo)})).length,
    };
  })()`);
  expect(finalBubbles).toEqual({ withFirstQueued: 1, withSecondQueued: 1, withBoth: 0 });
  {
    const shot = await screenshot(app);
    const seen = await validate(shot, [
      "The conversation shows two separate follow-up user messages, ONE before TWO, each followed by its own assistant reply",
      "No queued messages panel is visible anymore",
      "No error dialog or crash is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
  }
  evidence.recordAssertionEvidence(
    "Both queued follow-ups landed as separate FIFO user turns, never one merged message",
    `Engine session ${sessionId} ended with six messages in exact FIFO order (initial turn, its reply, first follow-up, its reply, second follow-up, its reply); ${mergedMessages.length} engine messages and ${isRecord(finalBubbles) ? String(finalBubbles.withBoth) : "?"} rendered user bubbles contained both follow-up texts; the provider served exactly three main completions ordered ${JSON.stringify(mainRequests.map((request) => request.label))}, and the drained turns' newest user messages were exactly the queued texts.`,
    finalSnapshot.messages.length === 6
      && mergedMessages.length === 0
      && turnTwo?.text.trim() === queuedPromptOne
      && turnThree?.text.trim() === queuedPromptTwo
      && drainTwoUserText.trim() === queuedPromptTwo
      && isRecord(finalBubbles)
      && finalBubbles.withFirstQueued === 1
      && finalBubbles.withSecondQueued === 1
      && finalBubbles.withBoth === 0,
  );
});
