import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { coworker, evalIn, fill, needs, test, waitFor } from "@openwork/testkit";
import { expect, onTestFinished } from "vitest";

/**
 * A turn that does not simply reply is still part of the conversation. A
 * deterministic OpenAI-compatible model plays the provider's bad days on cue:
 * rate limits that clear, a model that cannot use tools, a reply that takes
 * longer than the wait budget, a reply the person stops, replies that hold
 * while the person keeps typing, and a turn cut off before it finished.
 * Everything else — the engine, its own retries, the thread record beside the
 * coworker, the conversation, the header, and the rail — is the real product.
 *
 * The scripted model is on the runner's loopback, which a sandboxed app cannot
 * reach, so this journey runs on the local lane by construction.
 */

const enabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const title = enabled
  ? "Open Coworker keeps interruptions, retries, steering, and Next inside the conversation"
  : "Open Coworker turn recovery journey skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1";

const SCRIPTED_PROVIDER = "eval-scripted";
const FIRST_MODEL = "scripted";
const SECOND_MODEL = "scripted-2";
const SECOND_MODEL_LABEL = "Scripted two";

const TRANSIENT_PROMPT = "TRANSIENT: reply once the rate limit clears.";
const TRANSIENT_REPLY = "Back after the rate limit.";
/** The engine retries a rate limit by itself (five times, honouring Retry-After); one more refusal hands the retry to the app. */
const TRANSIENT_REFUSALS = 6;
const HARD_PROMPT = "HARD: this model cannot use tools.";
const SECOND_MODEL_REPLY = "Answered by the second model.";
const SLOW_PROMPT = "SLOW: take longer than two minutes.";
/** The first words arrive at once; the rest only after the hold. */
const SLOW_OPENING = "Thinking this through, one moment.";
const SLOW_REPLY = "Worth the wait.";
const SLOW_HOLD_MS = 130_000;
const STOP_PROMPT = "STOP: hold until I stop you.";
const STOP_REPLY = "Second time lucky.";
const HOLD_PROMPT = "HOLD: keep going for a while.";
const HOLD_REPLY = "Held reply.";
const HOLD_MS = 30_000;
const CUT_PROMPT = "CUT: hold until the app closes.";
const CUT_REPLY = "Continued after the cut.";
const DEFAULT_REPLY = "Okay.";

type Recorded = { model: string; prompt: string; at: number };

function json(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Cannot serialize an undefined browser value.");
  return serialized.replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { raw += chunk; });
    request.on("end", () => resolve(raw));
    request.on("error", reject);
  });
}

function lastUserText(body: unknown): string {
  if (!isRecord(body) || !Array.isArray(body.messages)) return "";
  const user = [...body.messages].reverse().find((message) => isRecord(message) && message.role === "user");
  if (!isRecord(user)) return "";
  const content = user.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : "")).join("\n");
  return "";
}

function chunk(model: string, delta: Record<string, unknown>, finish: string | null): string {
  return `data: ${JSON.stringify({ id: "chatcmpl-scripted", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

function streamReply(response: ServerResponse, model: string, text: string): void {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  response.write(chunk(model, { role: "assistant" }, null));
  response.write(chunk(model, { content: text }, null));
  response.write(chunk(model, {}, "stop"));
  response.write("data: [DONE]\n\n");
  response.end();
}

/** Responses still being held; a real provider drops these when the client goes away. */
const held = new Set<ServerResponse>();
/** What happened to held responses, for a failure message worth reading. */
const heldLog: string[] = [];

/**
 * Open the stream at once (with an opening line when given), then hold the rest for `holdMs`; a
 * closed connection (a stop, an abort) cancels the wait.
 */
function holdThenReply(response: ServerResponse, model: string, text: string, holdMs: number, opening = ""): void {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "close" });
  response.write(chunk(model, { role: "assistant" }, null));
  if (opening) response.write(chunk(model, { content: `${opening} ` }, null));
  held.add(response);
  const openedAt = Date.now();
  heldLog.push(`${text.slice(0, 12)} held at ${openedAt}`);
  const timer = setTimeout(() => {
    held.delete(response);
    if (response.writableEnded || response.destroyed) return;
    heldLog.push(`${text.slice(0, 12)} released by the hold after ${Date.now() - openedAt} ms`);
    response.write(chunk(model, { content: text }, null));
    response.write(chunk(model, {}, "stop"));
    response.write("data: [DONE]\n\n");
    response.end();
  }, holdMs);
  response.on("close", () => {
    heldLog.push(`${text.slice(0, 12)} connection closed after ${Date.now() - openedAt} ms`);
    held.delete(response);
    clearTimeout(timer);
  });
}

/**
 * What a provider does once the client has stopped listening: drop the held
 * response and its connection. The engine's runtime keeps an aborted stream's
 * connection around and would queue its next request behind it otherwise.
 */
function releaseHeld(): void {
  heldLog.push(`release asked with ${held.size} held`);
  for (const response of held) response.destroy();
  held.clear();
}

function refuse(response: ServerResponse, status: number, message: string, type: string, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify({ error: { message, type, param: null, code: type } }));
}

async function startScriptedModel(): Promise<{ baseUrl: string; requests: Recorded[]; countFor: (prompt: string) => number }> {
  const requests: Recorded[] = [];
  const seen = new Map<string, number>();
  const countFor = (prompt: string) => requests.filter((request) => request.prompt.includes(prompt)).length;
  const server = createServer((request, response) => {
    const url = request.url ?? "";
    if (request.method === "GET" && url.startsWith("/v1/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: FIRST_MODEL, object: "model" }, { id: SECOND_MODEL, object: "model" }] }));
      return;
    }
    if (request.method === "POST" && (url === "/v1/chat/completions" || url === "/chat/completions")) {
      void readBody(request).then((raw) => {
        let body: unknown = null;
        try { body = JSON.parse(raw); } catch { body = null; }
        const model = isRecord(body) && typeof body.model === "string" ? body.model : FIRST_MODEL;
        const prompt = lastUserText(body);
        requests.push({ model, prompt, at: Date.now() });
        const key = prompt.split(":")[0] ?? prompt;
        const nth = (seen.get(key) ?? 0) + 1;
        seen.set(key, nth);
        if (model === SECOND_MODEL) return streamReply(response, model, SECOND_MODEL_REPLY);
        if (prompt.includes("TRANSIENT")) {
          if (nth <= TRANSIENT_REFUSALS) return refuse(response, 429, "Rate limit exceeded, try again later", "rate_limit_error", { "retry-after": "1" });
          return streamReply(response, model, TRANSIENT_REPLY);
        }
        if (prompt.includes("HARD")) return refuse(response, 400, "No endpoints found that support tool use. Try disabling tools.", "invalid_request_error");
        if (prompt.includes("SLOW")) return holdThenReply(response, model, SLOW_REPLY, SLOW_HOLD_MS, SLOW_OPENING);
        if (prompt.includes("STOP")) return nth === 1 ? holdThenReply(response, model, "Never sent.", 120_000) : streamReply(response, model, STOP_REPLY);
        if (prompt.includes("HOLD")) return holdThenReply(response, model, HOLD_REPLY, HOLD_MS);
        if (prompt.includes("CUT")) return nth === 1 ? holdThenReply(response, model, "Never sent.", 90_000) : streamReply(response, model, CUT_REPLY);
        return streamReply(response, model, DEFAULT_REPLY);
      });
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: `scripted model: no route for ${request.method} ${url}` } }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  onTestFinished(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Scripted model did not bind a TCP port.");
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, requests, countFor };
}

type App = Awaited<ReturnType<typeof coworker>>;

async function invokeCoworker(app: App, command: string, payload: unknown): Promise<unknown> {
  return evalIn(app, `window.__COWORKER__.invoke(${json(command)}, ${json(payload)})`, { awaitPromise: true, timeoutMs: 120_000 });
}

function resultRecord(response: unknown): Record<string, unknown> {
  if (!isRecord(response) || response.ok !== true || !isRecord(response.result)) {
    throw new Error(`Open Coworker bridge returned an unexpected response: ${JSON.stringify(response)}`);
  }
  return response.result;
}

async function waitForNovaReady(app: App): Promise<void> {
  await waitFor(app, `Boolean(document.querySelector('[data-testid="coworker-discussion-view"]')) && [...document.querySelectorAll("h1")].some((heading) => heading.textContent?.trim() === "Nova")`, {
    timeoutMs: 120_000,
    label: "Nova discussion view",
  });
  await waitFor(app, `document.querySelector('[data-testid="coworker-top-status"]')?.textContent?.trim() === "Ready"`, { timeoutMs: 240_000, label: "Nova ready" });
}

/** Send from the field the way a person does; a message typed while a reply runs goes on Next. */
async function type(app: App, text: string): Promise<void> {
  await fill(app, 'textarea[aria-label="Message Nova"]', text);
  await evalIn(app, `(() => {
    const field = document.querySelector('textarea[aria-label="Message Nova"]');
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    return true;
  })()`);
}

async function waitForReply(app: App, text: string, timeoutMs = 60_000): Promise<void> {
  await waitFor(app, `[...document.querySelectorAll('[data-message-role="assistant"]')].some((message) => (message.textContent ?? "").includes(${json(text)}))`, {
    timeoutMs,
    label: `reply ${json(text)}`,
  });
}

/** Watch the words as they change: which outcomes the conversation named, and what the header said meanwhile. */
async function beginOutcomeTrace(app: App): Promise<void> {
  await evalIn(app, `(() => {
    window.__COWORKER_OUTCOME_TRACE__?.observer?.disconnect?.();
    const outcomes = new Set();
    const headers = new Set();
    const rails = new Set();
    const record = () => {
      for (const node of document.querySelectorAll('[data-outcome]')) outcomes.add(node.getAttribute("data-outcome"));
      headers.add(document.querySelector('[data-testid="coworker-top-status"]')?.textContent?.trim() ?? "");
      rails.add(document.querySelector('[data-testid="coworker-rail-line"]')?.textContent?.trim() ?? "");
    };
    const observer = new MutationObserver(record);
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    window.__COWORKER_OUTCOME_TRACE__ = { outcomes, headers, rails, observer };
    record();
    return true;
  })()`);
}

async function endOutcomeTrace(app: App): Promise<{ outcomes: string[]; headers: string[]; rails: string[] }> {
  const value = await evalIn(app, `(() => {
    const trace = window.__COWORKER_OUTCOME_TRACE__;
    trace?.observer?.disconnect?.();
    return { outcomes: [...(trace?.outcomes ?? [])], headers: [...(trace?.headers ?? [])], rails: [...(trace?.rails ?? [])] };
  })()`);
  if (!isRecord(value) || !Array.isArray(value.outcomes) || !Array.isArray(value.headers) || !Array.isArray(value.rails)) throw new Error("The outcome trace was unavailable.");
  return { outcomes: value.outcomes.map(String), headers: value.headers.map(String), rails: value.rails.map(String) };
}

const USER_BUBBLES = `[...document.querySelectorAll('[data-message-role="user"]')].map((node) => node.textContent?.trim() ?? "")`;

/** The turn settled: the header says Ready and the composer is not working. */
async function waitForSettled(app: App, timeoutMs = 120_000): Promise<void> {
  await waitFor(app, `document.querySelector('[data-testid="coworker-top-status"]')?.textContent?.trim() === "Ready" && document.querySelector('[data-testid="coworker-composer"]')?.getAttribute("data-working") !== "true"`, {
    timeoutMs,
    label: "the turn settled",
  });
}

/** The message left the field and the engine has its turn: its bubble is up, the live row is past Sending, and nothing waits as Next. */
async function waitUntilRunning(app: App, prompt: string): Promise<void> {
  await waitFor(app, `(() => {
    const users = ${USER_BUBBLES};
    const row = document.querySelector('[data-testid="coworker-working"]');
    return users.some((text) => text.includes(${json(prompt)}))
      && document.querySelector('[data-testid="coworker-composer"]')?.getAttribute("data-working") === "true"
      && row instanceof HTMLElement && row.dataset.phase !== "sending"
      && document.querySelectorAll('[data-testid="coworker-next-row"]').length === 0;
  })()`, { timeoutMs: 60_000, label: `${json(prompt)} running` });
}

/** The engine's own record of the thread: user messages by text, so a retried message is provably there once. */
async function engineUserMessages(serverUrl: string, token: string, workspaceId: string, threadId: string): Promise<string[]> {
  const response = await fetch(`${serverUrl}/workspace/${encodeURIComponent(workspaceId)}/opencode/session/${encodeURIComponent(threadId)}/message`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
  const messages: unknown = await response.json();
  if (!Array.isArray(messages)) throw new Error("The engine did not list the thread's messages.");
  return messages
    .filter((message): message is Record<string, unknown> => isRecord(message) && isRecord(message.info) && message.info.role === "user")
    .map((message) => (Array.isArray(message.parts) ? message.parts : [])
      .map((part) => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : ""))
      .join(""));
}

/** What the engine, the mock, and the record hold right now — for a failure message worth reading. */
async function describeThread(app: App, serverUrl: string, token: string, workspaceId: string, threadId: string, scripted: { requests: Recorded[] }): Promise<string> {
  const headers = { Authorization: `Bearer ${token}` };
  const base = `${serverUrl}/workspace/${encodeURIComponent(workspaceId)}/opencode`;
  const [messages, status, turns] = await Promise.all([
    fetch(`${base}/session/${encodeURIComponent(threadId)}/message`, { headers }).then((response) => response.json()).catch((error: unknown) => String(error)),
    fetch(`${base}/session/status`, { headers }).then((response) => response.json()).catch((error: unknown) => String(error)),
    invokeCoworker(app, "coworkers.files.read", { slug: "nova", path: "turns.json" }).catch((error: unknown) => String(error)),
  ]);
  const summary = Array.isArray(messages)
    ? messages.map((message) => {
      if (!isRecord(message) || !isRecord(message.info)) return message;
      const parts = Array.isArray(message.parts) ? message.parts.map((part) => (isRecord(part) ? `${String(part.type)}:${typeof part.text === "string" ? part.text.slice(0, 40) : ""}` : "?")) : [];
      return { id: message.info.id, role: message.info.role, parentID: message.info.parentID, completed: isRecord(message.info.time) ? message.info.time.completed : undefined, error: message.info.error ? JSON.stringify(message.info.error).slice(0, 200) : null, parts };
    })
    : messages;
  return JSON.stringify({ status, mock: scripted.requests.map((request) => `${request.model}:${request.prompt.slice(0, 24)}`), held: heldLog, messages: summary, turns }, null, 1);
}

test.skipIf(!enabled)(title, { timeout: 900_000 }, async ({ evidence }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"], commands: ["opencode"] });
  const scripted = await startScriptedModel();
  // No key from the runner's shell may reach the app: the scripted provider must be the only model
  // worth recommending besides the free one, so "Use <model>" is deterministic.
  await using app = await coworker({
    name: "turn-recovery",
    env: { ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", OPENROUTER_API_KEY: "", GEMINI_API_KEY: "", GOOGLE_API_KEY: "", XAI_API_KEY: "", GROQ_API_KEY: "", MISTRAL_API_KEY: "", DEEPSEEK_API_KEY: "" },
  });

  await waitFor(app, `(document.body?.innerText ?? "").toLowerCase().includes("welcome to open coworker")`, {
    timeoutMs: 120_000,
    label: "Open Coworker welcome screen",
  });
  const created = resultRecord(await invokeCoworker(app, "coworkers.create", {
    name: "Nova",
    role: "Research partner",
    mission: "Keep research work moving.",
    avatarColor: "mint",
    avatarGlasses: "round",
  }));
  const workspaceId = String(created.workspaceId);
  expect(workspaceId).not.toBe("");
  const runtime = resultRecord(await invokeCoworker(app, "runtime.info", {}));
  const serverUrl = String(runtime.serverUrl);
  const ownerToken = String(runtime.ownerToken);
  const providerPatch = await fetch(`${serverUrl}/workspace/${encodeURIComponent(workspaceId)}/config`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({
      opencode: {
        provider: {
          [SCRIPTED_PROVIDER]: {
            npm: "@ai-sdk/openai-compatible",
            name: "Scripted models",
            options: { baseURL: scripted.baseUrl, apiKey: "eval-scripted-key" },
            models: {
              [FIRST_MODEL]: { name: "Scripted one", tool_call: true },
              [SECOND_MODEL]: { name: SECOND_MODEL_LABEL, tool_call: true },
            },
          },
        },
      },
    }),
  });
  expect(providerPatch.status).toBe(200);
  const engineReload = await fetch(`${serverUrl}/workspace/${encodeURIComponent(workspaceId)}/engine/reload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ownerToken}` },
  });
  expect(engineReload.status).toBe(200);
  const useFirstModel = async () => {
    await invokeCoworker(app, "coworkers.update", { slug: "nova", patch: { model: `${SCRIPTED_PROVIDER}/${FIRST_MODEL}`, modelVariant: "" } });
    await evalIn(app, "location.reload(); true");
    await waitForNovaReady(app);
  };
  await useFirstModel();
  const threadIdOf = async () => String(resultRecord(await invokeCoworker(app, "coworkers.get", { slug: "nova" })).conversationThreadId);

  // --- (a) A rate limit that clears: trying again, live, then the reply — one message, held once. -------
  await beginOutcomeTrace(app);
  await type(app, TRANSIENT_PROMPT);
  await waitForReply(app, TRANSIENT_REPLY, 180_000);
  const transientTrace = await endOutcomeTrace(app);
  expect(transientTrace.outcomes).toContain("retrying");
  expect(transientTrace.outcomes).not.toContain("failed");
  expect(transientTrace.headers).toContain("Retrying");
  expect(transientTrace.headers).not.toContain("Reply failed");
  expect(transientTrace.rails.some((line) => line.startsWith("Couldn't reach the AI model."))).toBe(true);
  const transientBubbles = await evalIn(app, USER_BUBBLES);
  expect(Array.isArray(transientBubbles) && transientBubbles.filter((text) => String(text).includes("TRANSIENT")).length).toBe(1);
  expect(scripted.countFor("TRANSIENT")).toBeGreaterThanOrEqual(TRANSIENT_REFUSALS + 1);
  const threadId = await threadIdOf();
  const afterTransient = await engineUserMessages(serverUrl, ownerToken, workspaceId, threadId);
  expect(afterTransient.filter((text) => text.includes("TRANSIENT"))).toHaveLength(1);
  expect(await evalIn(app, `document.querySelectorAll('[data-testid="coworker-turn-failed"], [data-testid="coworker-turn-timeout"]').length`)).toBe(0);
  evidence.recordAssertionEvidence(
    "A rate limit that clears is trying again in the conversation, never a failure, and the message is in the thread once",
    `The scripted model refused ${TRANSIENT_REFUSALS} times with 429 and Retry-After; the conversation showed a retrying line while the engine and then the app tried again, the header read Retrying and the rail began "Couldn't reach the AI model.", no failure appeared, the reply landed after ${scripted.countFor("TRANSIENT")} requests, and the engine holds exactly one user message for it.`,
    true,
  );

  // --- (b) A model that cannot use tools: one coworker-side message with A, B, C; A switches model and retries the same message. ---
  await waitForSettled(app);
  await beginOutcomeTrace(app);
  await type(app, HARD_PROMPT);
  const hardCard = await waitFor(app, `(() => {
    const failure = document.querySelector('[data-testid="coworker-turn-failed"]');
    if (!failure) return false;
    const technical = failure.querySelector('[data-testid="coworker-turn-technical"]');
    return {
      headline: failure.querySelector('[data-testid="coworker-turn-headline"]')?.textContent?.trim() ?? "",
      text: failure.innerText ?? "",
      className: failure.className,
      needsYou: failure.getAttribute("data-needs-you"),
      technicalOpen: technical instanceof HTMLDetailsElement ? technical.open : null,
      choices: [...failure.querySelectorAll('[data-testid="coworker-turn-choice"]')].map((choice) => ({ letter: choice.getAttribute("data-letter"), choice: choice.getAttribute("data-choice"), label: choice.textContent?.trim() ?? "" })),
      widthRatio: failure.parentElement ? failure.getBoundingClientRect().width / failure.parentElement.getBoundingClientRect().width : null,
      header: document.querySelector('[data-testid="coworker-top-status"]')?.textContent?.trim() ?? "",
      threadStatus: document.querySelector('[data-testid="coworker-thread-status"]')?.textContent?.trim() ?? "",
      rail: document.querySelector('[data-testid="coworker-rail-line"]')?.textContent?.trim() ?? "",
      working: Boolean(document.querySelector('[data-testid="coworker-working"]')),
    };
  })()`, { timeoutMs: 120_000, label: "the failure as a coworker-side message" });
  if (!isRecord(hardCard) || !Array.isArray(hardCard.choices)) throw new Error("Failure card facts were unavailable.");
  expect(hardCard.headline).toBe("Nova's AI model cannot use the tools enabled for this coworker.");
  expect(hardCard.className).not.toMatch(/rose/);
  expect(hardCard.needsYou).toBe("true");
  expect(hardCard.technicalOpen).toBe(false);
  expect(String(hardCard.text)).not.toMatch(/APIError|status code|400/);
  expect(hardCard.choices.length).toBeLessThanOrEqual(3);
  expect(hardCard.choices.map((choice) => (isRecord(choice) ? `${choice.letter} ${choice.choice}` : ""))).toEqual(["A use-model", "B choose-model", "C continue-with-openwork"]);
  expect(hardCard.choices.map((choice) => (isRecord(choice) ? choice.label : ""))[0]).toContain(`Use ${SECOND_MODEL_LABEL}`);
  expect(Number(hardCard.widthRatio)).toBeLessThanOrEqual(0.8);
  expect(hardCard.header).toBe("Reply failed");
  expect(hardCard.threadStatus).toBe("Reply failed");
  expect(hardCard.rail).toBe("Nova's AI model cannot use the tools enabled for this coworker.");
  expect(hardCard.working).toBe(false);
  await evalIn(app, `document.querySelector('[data-testid="coworker-turn-choice"][data-choice="use-model"]').click(); true`);
  await waitForReply(app, SECOND_MODEL_REPLY, 120_000);
  // The turn settles a moment after its reply shows: the bubble goes, one receipt line stays.
  expect(await waitFor(app, `(() => {
    const lines = [...document.querySelectorAll('[data-testid="coworker-turn-line"][data-outcome="retried"]')].map((line) => line.textContent?.trim());
    return lines.length > 0 && document.querySelectorAll('[data-testid="coworker-turn-failed"]').length === 0 ? lines : false;
  })()`, { timeoutMs: 30_000, label: "the Retried with line" })).toEqual([`Retried with ${SECOND_MODEL_LABEL}`]);
  const hardTrace = await endOutcomeTrace(app);
  expect(hardTrace.outcomes).toContain("failed");
  const hardBubbles = await evalIn(app, USER_BUBBLES);
  expect(Array.isArray(hardBubbles) && hardBubbles.filter((text) => String(text).includes("HARD")).length).toBe(1);
  expect(scripted.requests.filter((request) => request.prompt.includes("HARD")).map((request) => request.model)).toEqual([FIRST_MODEL, SECOND_MODEL]);
  const afterHard = await engineUserMessages(serverUrl, ownerToken, workspaceId, threadId);
  expect(afterHard.filter((text) => text.includes("HARD"))).toHaveLength(1);
  expect(resultRecord(await invokeCoworker(app, "coworkers.get", { slug: "nova" })).model).toBe(`${SCRIPTED_PROVIDER}/${SECOND_MODEL}`);
  evidence.recordAssertionEvidence(
    "A model that cannot use tools is one message in the coworker's voice with three lettered ways out, and A retries the same message on another model",
    `The failure sat on Nova's side at the bubble's width with an amber dot and no rose, led with the headline, kept the provider's text folded and closed, and offered exactly A Use ${SECOND_MODEL_LABEL}, B Choose AI model, C Continue with OpenWork; the header, the thread status, and the rail all said the failure's own words. Choosing A switched Nova to ${SECOND_MODEL} and re-ran the same message id: the scripted model saw the prompt once per model, the engine holds one user message for it, and the conversation kept one user bubble plus a "Retried with" line.`,
    true,
  );
  await useFirstModel();

  // --- (c) A reply held past the wait budget is still working, not a problem. -------------------------
  await waitForSettled(app);
  await beginOutcomeTrace(app);
  await type(app, SLOW_PROMPT);
  await waitUntilRunning(app, SLOW_PROMPT);
  // An impatient tap on the live row shows one discreet line of what is streaming, live, then hides itself.
  await waitFor(app, `(() => {
    const row = document.querySelector('[data-testid="coworker-working"]');
    if (!(row instanceof HTMLElement) || row.dataset.peek !== "false") return false;
    row.querySelector('[data-testid="coworker-progress-phrase"]')?.click();
    return true;
  })()`, { timeoutMs: 30_000, label: "tap the live row" });
  const peek = await waitFor(app, `(() => {
    const line = document.querySelector('[data-testid="coworker-working-peek"]');
    if (!line || !(line.textContent ?? "").includes(${json(SLOW_OPENING)})) return false;
    return { text: line.textContent?.trim() ?? "", bubbles: document.querySelectorAll('[data-message-role="assistant"] .bubble').length };
  })()`, { timeoutMs: 30_000, label: "the glimpse of what is streaming" });
  expect(peek).toMatchObject({ text: SLOW_OPENING });
  const peekShownAt = Date.now();
  await waitFor(app, `!document.querySelector('[data-testid="coworker-working-peek"]') && document.querySelector('[data-testid="coworker-working"]')?.getAttribute("data-peek") === "false"`, { timeoutMs: 30_000, label: "the glimpse hid itself" });
  const peekLastedMs = Date.now() - peekShownAt;
  expect(peekLastedMs).toBeGreaterThan(5_000);
  expect(peekLastedMs).toBeLessThan(20_000);
  const slowRow = await waitFor(app, `(() => {
    const row = document.querySelector('[data-testid="coworker-working"][data-outcome="slow"]');
    if (!row) return false;
    return {
      phrase: row.querySelector('[data-testid="coworker-progress-phrase"]')?.textContent?.trim() ?? "",
      stop: Boolean(row.querySelector('[data-testid="coworker-turn-choice"][data-choice="stop"]')),
      header: document.querySelector('[data-testid="coworker-top-status"]')?.textContent?.trim() ?? "",
      threadStatus: document.querySelector('[data-testid="coworker-thread-status"]')?.textContent?.trim() ?? "",
      rail: document.querySelector('[data-testid="coworker-rail-line"]')?.textContent?.trim() ?? "",
      failed: document.querySelectorAll('[data-testid="coworker-turn-failed"], [data-testid="coworker-turn-timeout"], [data-testid="coworker-turn-line"][data-outcome="failed"]').length,
    };
  })()`, { timeoutMs: SLOW_HOLD_MS + 30_000, label: "the live row softened past the wait budget" });
  expect(slowRow).toEqual({ phrase: "Nova is still working on it…", stop: true, header: "Still working", threadStatus: "Still working", rail: "Still working on it", failed: 0 });
  await waitForReply(app, SLOW_REPLY, 60_000);
  const slowTrace = await endOutcomeTrace(app);
  expect(slowTrace.outcomes).toContain("slow");
  expect(slowTrace.outcomes).not.toContain("failed");
  expect(slowTrace.headers).not.toContain("Response delayed");
  expect(slowTrace.headers).not.toContain("Reply failed");
  evidence.recordAssertionEvidence(
    "Two minutes without a reply is still working, in the same words everywhere, a tap shows a glimpse of the stream, and the reply then lands",
    `The scripted model sent its first words and then held the rest for ${SLOW_HOLD_MS / 1_000} s. A tap on the live row showed one discreet line with the words streaming so far ("${SLOW_OPENING}") and hid it again by itself after ${Math.round(peekLastedMs / 1_000)} s. Past the wait budget the live row read "Nova is still working on it…" with one inline Stop, the header and thread status said Still working and the rail "Still working on it", nothing rose or card-shaped appeared, and the reply arrived afterwards.`,
    true,
  );

  // --- (d) Stop is one click away; Stopped. with Retry; Retry re-runs the same message. -------------
  await waitForSettled(app);
  await type(app, STOP_PROMPT);
  await waitUntilRunning(app, STOP_PROMPT);
  await waitFor(app, `document.querySelector('[data-testid="coworker-send"]')?.getAttribute("data-role") === "stop"`, { timeoutMs: 30_000, label: "the round control became Stop" });
  await evalIn(app, `document.querySelector('[data-testid="coworker-send"][data-role="stop"]').click(); true`);
  releaseHeld();
  const stoppedLine = await waitFor(app, `(() => {
    const line = document.querySelector('[data-testid="coworker-turn-line"][data-outcome="stopped-by-you"]');
    if (!line) return false;
    return {
      text: line.firstElementChild?.textContent?.trim() ?? "",
      choices: [...line.querySelectorAll('[data-testid="coworker-turn-choice"]')].map((choice) => choice.getAttribute("data-choice")),
      header: document.querySelector('[data-testid="coworker-top-status"]')?.textContent?.trim() ?? "",
      rail: document.querySelector('[data-testid="coworker-rail-line"]')?.textContent?.trim() ?? "",
      working: Boolean(document.querySelector('[data-testid="coworker-working"]')),
    };
  })()`, { timeoutMs: 60_000, label: "the Stopped. line" });
  expect(stoppedLine).toEqual({ text: "Stopped.", choices: ["retry"], header: "Stopped", rail: "Stopped.", working: false });
  await evalIn(app, `document.querySelector('[data-testid="coworker-turn-line"][data-outcome="stopped-by-you"] [data-choice="retry"]').click(); true`);
  try {
    await waitForReply(app, STOP_REPLY, 120_000);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nThread after Retry: ${await describeThread(app, serverUrl, ownerToken, workspaceId, threadId, scripted)}`);
  }
  const stopBubbles = await evalIn(app, USER_BUBBLES);
  expect(Array.isArray(stopBubbles) && stopBubbles.filter((text) => String(text).includes("STOP")).length).toBe(1);
  expect((await engineUserMessages(serverUrl, ownerToken, workspaceId, threadId)).filter((text) => text.includes("STOP"))).toHaveLength(1);
  expect(await evalIn(app, `document.querySelectorAll('[data-testid="coworker-turn-line"][data-outcome="stopped-by-you"]').length`)).toBe(0);
  evidence.recordAssertionEvidence(
    "Stop is the round control, stopping reads as one word with Retry, and Retry re-runs the same message",
    "While the scripted model held its reply the send control became a stop control; one click gave one quiet line — Stopped. · Retry — with the header saying Stopped and the rail the same word, and Retry re-ran the message under its own id: one user bubble, one user message in the engine, and the reply the second attempt produced.",
    true,
  );

  // --- (e) What you type while the coworker works waits as Next: in order, editable, removable, or sent now. ---
  await waitForSettled(app);
  await type(app, HOLD_PROMPT);
  await waitUntilRunning(app, HOLD_PROMPT);
  await type(app, "Next one");
  await type(app, "Next two");
  const rows = () => evalIn(app, `[...document.querySelectorAll('[data-testid="coworker-next-row"]')].map((row) => row.querySelector("span.truncate")?.textContent?.trim() ?? "")`);
  expect(await rows()).toEqual(["Next one", "Next two"]);
  expect(await evalIn(app, `document.querySelector('[data-testid="coworker-next-row"]')?.textContent ?? ""`)).toContain("Next · steers the reply that follows");
  // The record beside the coworker carries both: the turn in flight and what waits as Next.
  const turnsFile = await waitFor(app, `window.__COWORKER__.invoke("coworkers.files.read", { slug: "nova", path: "turns.json" })
    .then((response) => response.ok && response.result.content.includes("Next two") ? JSON.parse(response.result.content) : false)
    .catch(() => false)`, { timeoutMs: 30_000, label: "turns.json carries the pending turn and Next", awaitPromise: true });
  if (!isRecord(turnsFile) || !isRecord(turnsFile.threads) || !isRecord(turnsFile.threads[threadId])) throw new Error("turns.json did not name the thread.");
  const recorded = turnsFile.threads[threadId];
  expect(isRecord(recorded.pending) ? recorded.pending.prompt : null).toBe(HOLD_PROMPT);
  expect(Array.isArray(recorded.next) ? recorded.next.map((item) => (isRecord(item) ? item.text : null)) : null).toEqual(["Next one", "Next two"]);
  await evalIn(app, `[...document.querySelectorAll('[data-testid="coworker-next-row"]')][1].querySelector('[data-testid="coworker-next-edit"]').click(); true`);
  expect(await evalIn(app, `document.querySelector('textarea[aria-label="Message Nova"]')?.value`)).toBe("Next two");
  expect(await rows()).toEqual(["Next one"]);
  await type(app, "Next three");
  expect(await rows()).toEqual(["Next one", "Next three"]);
  await evalIn(app, `[...document.querySelectorAll('[data-testid="coworker-next-row"]')][1].querySelector('[data-testid="coworker-next-remove"]').click(); true`);
  expect(await rows()).toEqual(["Next one"]);
  await evalIn(app, `document.querySelector('[data-testid="coworker-next-row"] [data-testid="coworker-next-send-now"]').click(); true`);
  releaseHeld();
  await waitFor(app, `[...document.querySelectorAll('[data-message-role="user"]')].some((node) => (node.textContent ?? "").trim() === "Next one")`, { timeoutMs: 30_000, label: "Send now sent the waiting message" });
  await waitForReply(app, DEFAULT_REPLY, 60_000);
  expect(await rows()).toEqual([]);
  // The stopped turn keeps its one line in the transcript, between its bubble and the message sent now.
  expect(await evalIn(app, `[...document.querySelectorAll('[data-testid="coworker-turn-line"][data-outcome="stopped"]')].map((line) => line.textContent?.trim())`)).toEqual(["Stopped."]);
  expect((await engineUserMessages(serverUrl, ownerToken, workspaceId, threadId)).filter((text) => text.includes("HOLD"))).toHaveLength(1);

  // Then the ordinary case: two messages wait, and drain one at a time, in order, once the reply lands.
  await waitForSettled(app);
  await type(app, `${HOLD_PROMPT} Again.`);
  await waitUntilRunning(app, `${HOLD_PROMPT} Again.`);
  await type(app, "Drain A");
  await type(app, "Drain B");
  expect(await rows()).toEqual(["Drain A", "Drain B"]);
  await waitFor(app, `(() => {
    const users = ${USER_BUBBLES};
    return users.at(-1) === "Drain B" && document.querySelectorAll('[data-testid="coworker-next-row"]').length === 0;
  })()`, { timeoutMs: HOLD_MS + 120_000, label: "Next drained in order" });
  await waitFor(app, `document.querySelector('[data-testid="coworker-top-status"]')?.textContent?.trim() === "Ready"`, { timeoutMs: 120_000, label: "the queue settled" });
  const drained = await engineUserMessages(serverUrl, ownerToken, workspaceId, threadId);
  const drainIndex = drained.findIndex((text) => text.includes("HOLD") && text.includes("Again"));
  expect(drainIndex).toBeGreaterThan(-1);
  expect(drained.slice(drainIndex)).toEqual([`${HOLD_PROMPT} Again.`, "Drain A", "Drain B"]);
  expect(scripted.countFor("Drain A")).toBe(1);
  expect(scripted.countFor("Drain B")).toBe(1);
  evidence.recordAssertionEvidence(
    "Messages typed while the coworker works wait as Next, can be edited, removed, or sent now, and drain in order",
    "With a reply held, two messages became two Next rows in order (the first saying it steers the reply that follows), recorded in turns.json beside the pending turn; Edit returned the second to the field, a new one took its place, Remove dropped it, and Send now stopped the held reply (one quiet Stopped. line stayed in the transcript) and sent the waiting message at once. Two more messages then drained one at a time after the held reply landed, in order, each once.",
    true,
  );

  // --- (f) A turn cut off before it finished reads as such, Continue finishes it, and Next drains after. ---
  // The window's reload does not stop the engine by itself, so the engine's turn is interrupted while
  // the window is away — the same interruption a quit of the app produces — and the record on disk is
  // what the returning window reads.
  await waitForSettled(app);
  await type(app, CUT_PROMPT);
  await waitUntilRunning(app, CUT_PROMPT);
  await type(app, "After the cut");
  expect(await rows()).toEqual(["After the cut"]);
  await evalIn(app, "location.reload(); true");
  const aborted = await fetch(`${serverUrl}/workspace/${encodeURIComponent(workspaceId)}/opencode/session/${encodeURIComponent(threadId)}/abort`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ownerToken}` },
  });
  expect(aborted.status).toBe(200);
  releaseHeld();
  await waitFor(app, `Boolean(document.querySelector('[data-testid="coworker-discussion-view"]')) && [...document.querySelectorAll("h1")].some((heading) => heading.textContent?.trim() === "Nova")`, { timeoutMs: 120_000, label: "Nova discussion view after the reload" });
  const cutLine = await waitFor(app, `(() => {
    const line = document.querySelector('[data-testid="coworker-turn-line"][data-outcome="cut-off"]');
    if (!line) return false;
    return {
      text: line.firstElementChild?.textContent?.trim() ?? "",
      choices: [...line.querySelectorAll('[data-testid="coworker-turn-choice"]')].map((choice) => choice.getAttribute("data-choice")),
      header: document.querySelector('[data-testid="coworker-top-status"]')?.textContent?.trim() ?? "",
      rail: document.querySelector('[data-testid="coworker-rail-line"]')?.textContent?.trim() ?? "",
      next: [...document.querySelectorAll('[data-testid="coworker-next-row"]')].map((row) => row.querySelector("span.truncate")?.textContent?.trim() ?? ""),
      failed: document.querySelectorAll('[data-testid="coworker-turn-failed"]').length,
    };
  })()`, { timeoutMs: 120_000, label: "the cut-off line after the reload" });
  expect(cutLine).toEqual({ text: "Stopped when the app closed before Nova replied.", choices: ["continue", "discard"], header: "Stopped", rail: "Stopped when the app closed before Nova replied.", next: ["After the cut"], failed: 0 });
  const beforeContinue = await describeThread(app, serverUrl, ownerToken, workspaceId, threadId, scripted);
  await evalIn(app, `document.querySelector('[data-testid="coworker-turn-line"][data-outcome="cut-off"] [data-choice="continue"]').click(); true`);
  try {
    await waitForReply(app, CUT_REPLY, 120_000);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nThread at the cut-off line: ${beforeContinue}\nThread after Continue timed out: ${await describeThread(app, serverUrl, ownerToken, workspaceId, threadId, scripted)}`);
  }
  try {
    await waitFor(app, `(() => {
      const users = ${USER_BUBBLES};
      return users.at(-1) === "After the cut" && document.querySelectorAll('[data-testid="coworker-next-row"]').length === 0;
    })()`, { timeoutMs: 120_000, label: "Next drained after Continue" });
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nThread after the drain wait: ${await describeThread(app, serverUrl, ownerToken, workspaceId, threadId, scripted)}`);
  }
  await waitFor(app, `document.querySelector('[data-testid="coworker-top-status"]')?.textContent?.trim() === "Ready"`, { timeoutMs: 120_000, label: "settled after the cut" });
  const afterCut = await engineUserMessages(serverUrl, ownerToken, workspaceId, threadId);
  expect(afterCut.filter((text) => text.includes("CUT"))).toHaveLength(1);
  expect(afterCut.at(-1)).toBe("After the cut");
  expect(await evalIn(app, `document.querySelectorAll('[data-testid="coworker-turn-line"][data-outcome="cut-off"]').length`)).toBe(0);
  evidence.recordAssertionEvidence(
    "A turn cut off before it finished reads as such after a reload, Continue finishes it under the same message id, and Next drains after",
    "With the reply held and one message waiting as Next, the window reloaded while the engine's turn was interrupted. The returning window read the record beside the coworker and showed one quiet line — Stopped when the app closed before Nova replied. · Continue · Discard — with the header saying Stopped and the rail the same line, the Next row still there, and no failure card. Continue re-ran the message under its own id and its reply landed; the waiting message then went by itself, and the engine holds one user message for the cut turn.",
    true,
  );
});
