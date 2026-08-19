import { createServer } from "node:http";
import { expect, onTestFinished } from "vitest";
import { clickButton, control, createAndSelectWorkspace, evalIn, waitFor } from "@openwork/behaviors";
import type { Surface } from "@openwork/cdp";
import { screenshot, validate } from "@openwork/test-evidence";
import { desktop } from "@openwork/hosts";
import { needs, test } from "@openwork/testkit";

const providerId = "safe-edit-resend-mock";
const modelId = "safe-edit-resend-model";
const firstPrompt = "First turn for safe edit proof.";
const secondPrompt = "Second turn that should be replaced.";
const editedPrompt = "Edited second turn that replaces the original.";
const legacyPrompt = "Legacy session restore proof.";
const replies = [
  "Deterministic first reply.",
  "Deterministic second reply.",
  "Deterministic edited reply.",
  "Deterministic legacy reply.",
];
const e2eTestsEnabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const title = e2eTestsEnabled
  ? "edit resend defers history mutation, rolls back failures, and restores stranded sessions"
  : "safe edit resend skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type RuntimeCredentials = { port: string; token: string };
type EngineMessage = { id: string; role: string; text: string };
type EngineSnapshot = { sessionId: string; revertMessageId: string | null; messages: EngineMessage[] };

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
  const revert = isRecord(item.session.revert) && typeof item.session.revert.messageID === "string"
    ? item.session.revert.messageID
    : null;
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
  return { sessionId: item.session.id, revertMessageId: revert, messages };
}

async function readEngineSnapshot(
  credentials: RuntimeCredentials,
  workspaceId: string,
  sessionId: string,
): Promise<EngineSnapshot> {
  // Bound every runner-side fetch: the workspace passthrough can hold a
  // request open while the engine restarts, and an unbounded fetch would
  // consume undici's five-minute header timeout in one blocking call.
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
  const deadline = Date.now() + 45_000;
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

async function enterAndSend(app: Surface, text: string): Promise<void> {
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
  await clickButton(app, "Run task", { timeoutMs: 30_000 });
}

async function waitForReply(app: Surface, reply: string): Promise<void> {
  await waitFor(app, `[...document.querySelectorAll('[data-message-role="assistant"]')]
    .some((message) => message.textContent?.includes(${JSON.stringify(reply)}))`, {
    timeoutMs: 120_000,
    label: `assistant reply ${reply}`,
  });
}

async function applyEngineRevert(
  credentials: RuntimeCredentials,
  workspaceId: string,
  sessionId: string,
  messageId: string,
): Promise<void> {
  const response = await fetch(
    `http://127.0.0.1:${credentials.port}/workspace/${encodeURIComponent(workspaceId)}/opencode/session/${encodeURIComponent(sessionId)}/revert`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credentials.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ messageID: messageId }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok) throw new Error(`Direct revert failed: ${response.status} ${(await response.text()).slice(0, 500)}`);
}

test.skipIf(!e2eTestsEnabled)(title, async ({ evidence }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });

  // The engine also sends small utility requests (session titles) to the same
  // provider, so replies must key off conversation content, never ordinals.
  // Utility requests carry no tools array; real agent turns always do.
  let mainCompletionCount = 0;
  const pickReply = (rawBody: string): string | null => {
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      parsedBody = null;
    }
    const tools = isRecord(parsedBody) ? parsedBody.tools : undefined;
    if (!Array.isArray(tools) || tools.length === 0) return null;
    if (rawBody.includes(editedPrompt)) return replies[2];
    if (rawBody.includes(secondPrompt)) return replies[1];
    if (rawBody.includes(legacyPrompt)) return replies[3];
    if (rawBody.includes(firstPrompt)) return replies[0];
    return `Unexpected completion for: ${rawBody.slice(0, 200)}`;
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
        const reply = pickReply(rawBody) ?? "Session title";
        if (reply !== "Session title") mainCompletionCount += 1;
        const id = `chatcmpl-safe-edit-${mainCompletionCount}`;
        const chunks = [
          { id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
          { id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: reply }, finish_reason: null }] },
          { id, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ];
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        // Pace the stream like a real model. An instantly-finished turn can
        // complete before the renderer's engine event stream (re)connects,
        // leaving the UI permanently stale on this turn.
        let delay = 400;
        for (const chunk of chunks) {
          setTimeout(() => response.write(`data: ${JSON.stringify(chunk)}\n\n`), delay);
          delay += 400;
        }
        setTimeout(() => response.end("data: [DONE]\n\n"), delay);
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
    await new Promise<void>((resolve, reject) => mock.close((error) => error ? reject(error) : resolve()));
  });
  const address = mock.address();
  if (!address || typeof address === "string") throw new Error("Mock provider did not bind a TCP port.");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;

  await using app = await desktop({
    name: "safe-edit-resend",
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
  const workspace = await createAndSelectWorkspace(app, {
    path: `/tmp/openwork-safe-edit-resend-${Date.now()}`,
  });
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
              name: "Safe edit resend mock",
              options: { baseURL: ${JSON.stringify(baseUrl)}, apiKey: "sk-safe-edit-resend" },
              models: { [${JSON.stringify(modelId)}]: { name: "Safe edit resend model" } },
            },
          },
        },
      }),
    });
    if (patched !== "ok") return patched;
    const reloaded = await request("/workspace/" + encodeURIComponent(workspaceId) + "/engine/reload", { method: "POST" });
    // A slow dispose reports 504 opencode_reload_timeout while the reload
    // keeps going; the engine-ready poll below owns convergence.
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
  // Preferences hydrate at boot, so reload unconditionally: without this the
  // engine's built-in free model stays the default and out-competes the mock.
  await evalIn(app, "location.reload(); true");
  await waitFor(app, "Boolean(window.__openworkControl)", {
    timeoutMs: 30_000,
    label: "app reloaded with safe edit mock model preferences",
  });

  const credentials = parseRuntimeCredentials(await evalIn(app, `JSON.stringify({
    port: localStorage.getItem("openwork.server.port") ?? "",
    token: localStorage.getItem("openwork.server.token") ?? "",
  })`));
  // The engine restarts after /engine/reload; sending into that window races
  // the swap and strands the run behind an "OpenCode unavailable" banner.
  await waitForEngineReady(credentials, workspace.workspaceId);
  await waitFor(app, `window.__openworkControl.listActions().some((action) => action.id === "session.create_task" && !action.disabled)`, {
    timeoutMs: 30_000,
    label: "new task action enabled",
  });
  await control(app, "session.create_task");
  // The session id is minted on the first send, so capture it afterwards.
  await enterAndSend(app, firstPrompt);
  const firstSessionId = await activeSessionId(app);
  await waitForReply(app, replies[0]);
  await enterAndSend(app, secondPrompt);
  await waitForReply(app, replies[1]);
  const seeded = await waitForEngineSnapshot(
    credentials,
    workspace.workspaceId,
    firstSessionId,
    "two-turn seed",
    (snapshot) => snapshot.messages.length === 4 && snapshot.messages.some((message) => message.text === replies[1]),
  );
  // The first user prompt renders as the task header, so the editable user
  // bubbles start at the second turn. Baseline the rendered bubbles from the
  // DOM itself; engine and DOM message counts intentionally differ.
  const renderedBaseline = await evalIn(app, `document.querySelectorAll('[data-message-role]').length`);
  if (typeof renderedBaseline !== "number" || renderedBaseline < 1) {
    throw new Error(`Rendered transcript baseline unavailable: ${String(renderedBaseline)}`);
  }

  const clickEditOnSecondTurn = async (): Promise<void> => {
    const editClicked = await evalIn(app, `(() => {
      const message = [...document.querySelectorAll('[data-message-role="user"]')]
        .find((bubble) => bubble.textContent?.includes(${JSON.stringify(secondPrompt)}));
      const button = message?.querySelector('button[aria-label="Edit message"]');
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click();
      return true;
    })()`);
    expect(editClicked).toBe(true);
    await waitFor(app, `(() => {
      const editor = document.querySelector('[contenteditable="true"][data-lexical-editor="true"]');
      return editor instanceof HTMLElement && (editor.innerText ?? "").trim() === ${JSON.stringify(secondPrompt)};
    })()`, { timeoutMs: 10_000, label: "edit put the original prompt into the composer" });
    // Replace the draft in one step (select-all + insert) so it never passes
    // through an empty state, which would deliberately drop the edit target.
    const selected = await evalIn(app, `(() => {
      const editor = document.querySelector('[contenteditable="true"][data-lexical-editor="true"]');
      if (!(editor instanceof HTMLElement)) return false;
      editor.focus();
      document.execCommand("selectAll");
      return true;
    })()`);
    expect(selected).toBe(true);
    await app.client.send("Input.insertText", { text: editedPrompt });
    await waitFor(app, `(document.querySelector('[contenteditable="true"][data-lexical-editor="true"]')?.innerText ?? "").trim() === ${JSON.stringify(editedPrompt)}`, {
      timeoutMs: 10_000,
      label: "edited replacement text in composer",
    });
  };

  await clickEditOnSecondTurn();
  await waitFor(app, `document.querySelectorAll('[data-message-role]').length === ${renderedBaseline}`, {
    timeoutMs: 10_000,
    label: "transcript unchanged while editing",
  });
  const afterEdit = await readEngineSnapshot(credentials, workspace.workspaceId, firstSessionId);
  expect(afterEdit.messages.map((message) => message.id)).toEqual(seeded.messages.map((message) => message.id));
  expect(afterEdit.revertMessageId).toBeNull();
  evidence.recordAssertionEvidence(
    "Editing an earlier user message is non-destructive until send",
    `The composer held the original then the edited text, all ${renderedBaseline} rendered messages stayed visible, and engine session ${firstSessionId} kept all ${seeded.messages.length} messages with no revert cursor.`,
    true,
  );

  const faultInstalled = await evalIn(app, `(() => {
    const originalKey = "__openworkSafeEditOriginalFetch";
    const countKey = "__openworkSafeEditFaultCount";
    if (!globalThis[originalKey]) globalThis[originalKey] = globalThis.fetch.bind(globalThis);
    const original = globalThis[originalKey];
    globalThis[countKey] = 0;
    globalThis.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
      const method = input instanceof Request ? input.method : init?.method ?? "GET";
      if (method.toUpperCase() === "POST" && url.includes(${JSON.stringify(`/opencode/session/${firstSessionId}/prompt_async`)})) {
        globalThis[countKey] += 1;
        return Promise.resolve(new Response("<html>injected prompt failure</html>", {
          status: 502,
          headers: { "content-type": "text/html" },
        }));
      }
      return original(input, init);
    };
    return true;
  })()`);
  expect(faultInstalled).toBe(true);
  await clickButton(app, "Run task", { timeoutMs: 30_000 });
  // The failure surfaces as an error card plus a synthetic error row, so
  // assert on preserved content rather than an exact bubble count.
  await waitFor(app, `(() => {
    const error = document.querySelector('[data-testid="session-error-card"]');
    const transcript = [...document.querySelectorAll('[data-message-role]')]
      .map((bubble) => bubble.innerText ?? "").join(" | ");
    return error instanceof HTMLElement
      && error.offsetParent !== null
      && transcript.includes(${JSON.stringify(replies[0])})
      && transcript.includes(${JSON.stringify(secondPrompt)})
      && transcript.includes(${JSON.stringify(replies[1])})
      && globalThis["__openworkSafeEditFaultCount"] === 1;
  })()`, { timeoutMs: 30_000, label: "failed edit send kept transcript and surfaced error" });
  const rolledBack = await waitForEngineSnapshot(
    credentials,
    workspace.workspaceId,
    firstSessionId,
    "failed edit rollback",
    (snapshot) => snapshot.revertMessageId === null && snapshot.messages.length === seeded.messages.length,
  );
  expect(rolledBack.messages.map((message) => message.id)).toEqual(seeded.messages.map((message) => message.id));
  expect(rolledBack.messages.some((message) => message.text === editedPrompt)).toBe(false);
  expect(mainCompletionCount).toBe(2);
  evidence.recordAssertionEvidence(
    "A failed replacement prompt rolls back its successful revert",
    `The injected prompt_async fault produced a visible error while the first reply, the original second turn, and its reply stayed visible, the provider stayed at two main completions, and the engine kept all ${seeded.messages.length} original messages with no revert cursor and no edited turn.`,
    true,
  );

  const faultCleared = await evalIn(app, `(() => {
    const original = globalThis["__openworkSafeEditOriginalFetch"];
    if (typeof original !== "function") return false;
    globalThis.fetch = original;
    delete globalThis["__openworkSafeEditOriginalFetch"];
    delete globalThis["__openworkSafeEditFaultCount"];
    return true;
  })()`);
  expect(faultCleared).toBe(true);
  // The failed send replaces the composer with the error state, so dismiss it
  // the way a user would, then run the edit flow again before retrying.
  const dismissed = await evalIn(app, `(() => {
    const button = document.querySelector('button[aria-label="Dismiss error"]');
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  })()`);
  expect(dismissed).toBe(true);
  await waitFor(app, `Boolean(document.querySelector('[contenteditable="true"][data-lexical-editor="true"]'))`, {
    timeoutMs: 10_000,
    label: "composer restored after dismissing the send error",
  });
  await clickEditOnSecondTurn();
  await clickButton(app, "Run task", { timeoutMs: 30_000 });
  await waitForReply(app, replies[2]);
  await waitFor(app, `(() => {
    const text = [...document.querySelectorAll('[data-message-role]')]
      .map((bubble) => bubble.innerText ?? "").join(" | ");
    return text.includes(${JSON.stringify(editedPrompt)})
      && text.includes(${JSON.stringify(replies[2])})
      && text.includes(${JSON.stringify(replies[0])})
      && !text.includes(${JSON.stringify(secondPrompt)})
      && !text.includes(${JSON.stringify(replies[1])});
  })()`, { timeoutMs: 30_000, label: "successful edit replaces transcript tail" });
  const replaced = await waitForEngineSnapshot(
    credentials,
    workspace.workspaceId,
    firstSessionId,
    "successful edited turn",
    (snapshot) => snapshot.revertMessageId === null
      && snapshot.messages.some((message) => message.role === "user" && message.text.includes(editedPrompt))
      && snapshot.messages.some((message) => message.text === replies[2]),
  );
  expect(replaced.messages.some((message) => message.text === secondPrompt)).toBe(false);
  expect(replaced.messages.some((message) => message.text === replies[1])).toBe(false);
  expect(replaced.messages.some((message) => message.text === replies[0])).toBe(true);
  expect(mainCompletionCount).toBe(3);
  evidence.recordAssertionEvidence(
    "Retrying the edited draft replaces the old tail and receives a new reply",
    `The DOM and engine contain the edited turn plus ${JSON.stringify(replies[2])} while keeping the first reply, and the second user turn and its reply are gone from both.`,
    true,
  );

  await control(app, "session.create_task");
  await enterAndSend(app, legacyPrompt);
  const legacySessionId = await activeSessionId(app);
  expect(legacySessionId).not.toBe(firstSessionId);
  await waitForReply(app, replies[3]);
  const legacySeeded = await waitForEngineSnapshot(
    credentials,
    workspace.workspaceId,
    legacySessionId,
    "legacy session seed",
    (snapshot) => snapshot.messages.length === 2 && snapshot.messages.some((message) => message.text === replies[3]),
  );
  const legacyFirstUser = legacySeeded.messages.find((message) => message.role === "user");
  if (!legacyFirstUser) throw new Error("Legacy seed has no user message.");
  await applyEngineRevert(credentials, workspace.workspaceId, legacySessionId, legacyFirstUser.id);
  const stranded = await waitForEngineSnapshot(
    credentials,
    workspace.workspaceId,
    legacySessionId,
    "legacy stranded cursor",
    (snapshot) => snapshot.revertMessageId === legacyFirstUser.id,
  );
  expect(stranded.messages.length).toBe(legacySeeded.messages.length);

  await evalIn(app, "location.reload(); true");
  await waitFor(app, `document.querySelector('[data-session-surface-id]')?.getAttribute('data-session-surface-id') === ${JSON.stringify(legacySessionId)}`, {
    timeoutMs: 30_000,
    label: "stranded session reloaded",
  });
  await waitFor(app, `(() => {
    const banner = document.querySelector('[data-testid="reverted-messages-banner"]');
    return banner instanceof HTMLElement
      && banner.offsetParent !== null
      && banner.textContent?.includes(${JSON.stringify(`${legacySeeded.messages.length} earlier messages are hidden`)})
      && [...banner.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Restore")
      && document.querySelectorAll('[data-message-role]').length === 0;
  })()`, { timeoutMs: 30_000, label: "stranded session restore banner" });
  {
    const shot = await screenshot(app);
    const seen = await validate(shot, [
      `A visible banner says ${legacySeeded.messages.length} earlier messages are hidden and offers a Restore button`,
      "The conversation is not a silent blank state even though its reverted transcript is hidden",
      "No crash dialog is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
  }

  await clickButton(app, "Restore", { timeoutMs: 30_000 });
  // The first user prompt renders as the task header rather than a bubble, so
  // assert on restored content, not on an engine-equal bubble count.
  await waitFor(app, `(() => {
    return !document.querySelector('[data-testid="reverted-messages-banner"]')
      && document.querySelectorAll('[data-message-role]').length >= 1
      && document.body.innerText.includes(${JSON.stringify(replies[3])});
  })()`, { timeoutMs: 30_000, label: "stranded session restored" });
  const restored = await waitForEngineSnapshot(
    credentials,
    workspace.workspaceId,
    legacySessionId,
    "engine unreverted",
    (snapshot) => snapshot.revertMessageId === null && snapshot.messages.length === legacySeeded.messages.length,
  );
  expect(restored.messages.map((message) => message.id)).toEqual(legacySeeded.messages.map((message) => message.id));
  {
    const shot = await screenshot(app);
    const seen = await validate(shot, [
      "The restored conversation visibly contains both the user prompt and deterministic assistant reply",
      "The hidden-messages banner and Restore button are gone",
      "No error or crash dialog is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
  }
  evidence.recordAssertionEvidence(
    "A legacy stranded revert has a visible restore path",
    `The banner named ${legacySeeded.messages.length} hidden messages; Restore removed the engine cursor, restored every original message, and removed the banner.`,
    true,
  );
});
