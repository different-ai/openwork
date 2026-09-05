import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { coworker, evalIn, fill, needs, screenshot, test, waitFor } from "@openwork/testkit";
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
/** The free model's shared limit, as the free provider answers it: a 429 whose body names FreeUsageLimitError. */
const FREE_PROMPT = "FREE: the free model is past its shared limit.";
const FREE_REPLY = "Back once the free model had room.";
const FREE_PROVIDER_MESSAGE = "Error from provider (Console): Rate limit exceeded. Please try again later.";
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

type Recorded = { model: string; prompt: string; at: number; tools: string[] };

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

/** Responses still being held, so a failure can say what became of them. */
const held = new Set<ServerResponse>();
/** What happened to held responses, for a failure message worth reading. */
const heldLog: string[] = [];

/** A model that is taking its time still produces a token now and then; a wholly silent stream is not how providers behave. */
const KEEP_ALIVE_MS = 2_000;

/**
 * Open the stream at once (with an opening line when given), then hold the rest for `holdMs`,
 * sending one space every couple of seconds meanwhile the way a slow model keeps streaming; a
 * closed connection (a stop, an abort) cancels the wait. The engine can only act on an abort
 * when the provider stream yields something, so a held reply must not fall wholly silent.
 */
function holdThenReply(response: ServerResponse, model: string, text: string, holdMs: number, opening = ""): () => void {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "close" });
  response.write(chunk(model, { role: "assistant" }, null));
  if (opening) response.write(chunk(model, { content: `${opening} ` }, null));
  held.add(response);
  const openedAt = Date.now();
  heldLog.push(`${text.slice(0, 12)} held at ${openedAt}`);
  const keepAlive = setInterval(() => {
    if (response.writableEnded || response.destroyed) return;
    response.write(chunk(model, { content: " " }, null));
  }, KEEP_ALIVE_MS);
  const finish = () => {
    held.delete(response);
    clearInterval(keepAlive);
    if (response.writableEnded || response.destroyed) return;
    heldLog.push(`${text.slice(0, 12)} released by the hold after ${Date.now() - openedAt} ms`);
    response.write(chunk(model, { content: text }, null));
    response.write(chunk(model, {}, "stop"));
    response.write("data: [DONE]\n\n");
    response.end();
  };
  const timer = setTimeout(finish, holdMs);
  response.on("close", () => {
    heldLog.push(`${text.slice(0, 12)} connection closed after ${Date.now() - openedAt} ms`);
    held.delete(response);
    clearInterval(keepAlive);
    clearTimeout(timer);
  });
  return () => { clearTimeout(timer); finish(); };
}

function refuse(response: ServerResponse, status: number, message: string, type: string, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify({ error: { message, type, param: null, code: type } }));
}

/** Prompts whose reply is being held on purpose right now; the journey holds and releases them around a stop. */
const holding = new Set<string>();

async function startScriptedModel(): Promise<{ baseUrl: string; requests: Recorded[]; countFor: (prompt: string) => number; hold: (key: string) => void; release: (key: string) => void; controlWorker: (id: string) => void }> {
  const requests: Recorded[] = [];
  let controlledWorker = "";
  let releaseBackground = (): void => undefined;
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
        const tools = isRecord(body) && Array.isArray(body.tools) ? body.tools.flatMap((tool) => isRecord(tool) && isRecord(tool.function) && typeof tool.function.name === "string" ? [tool.function.name] : []) : [];
        requests.push({ model, prompt, at: Date.now(), tools });
        const key = prompt.split(":")[0] ?? prompt;
        const nth = (seen.get(key) ?? 0) + 1;
        seen.set(key, nth);
        if (prompt === "Pause the background check for now." || prompt === "Resume the background check.") {
          const pause = prompt.startsWith("Pause");
          const last = isRecord(body) && Array.isArray(body.messages) ? body.messages.at(-1) : null;
          if (isRecord(last) && last.role === "tool") return streamReply(response, model, pause ? "The background check is paused." : "The background check is resumed.");
          response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
          response.write(chunk(model, { role: "assistant", tool_calls: [{ index: 0, id: pause ? "pause-background" : "resume-background", type: "function", function: { name: pause ? "coworker_worker_pause" : "coworker_worker_resume", arguments: JSON.stringify({ id: controlledWorker }) } }] }, null));
          response.write(chunk(model, {}, "tool_calls"));
          response.end("data: [DONE]\n\n");
          return;
        }
        if (prompt.startsWith("You are a Worker") && prompt.includes("BACKGROUND_RELIABILITY")) {
          if (prompt.includes("KEEP THIS STEERING")) return streamReply(response, model, "## Done\nKept the steering after restart.");
          releaseBackground = holdThenReply(response, model, "## Finding\nFirst bounded step complete.", 180_000);
          return;
        }
        if (prompt.startsWith("You are a Worker") && prompt.includes("BACKGROUND_INTERRUPTED")) {
          return holdThenReply(response, model, "## Finding\nThis interrupted reply should not be replayed.", 180_000);
        }
        if (model === SECOND_MODEL) return streamReply(response, model, SECOND_MODEL_REPLY);
        if (prompt.includes("TRANSIENT")) {
          if (nth <= TRANSIENT_REFUSALS) return refuse(response, 429, "Rate limit exceeded, try again later", "rate_limit_error", { "retry-after": "1" });
          return streamReply(response, model, TRANSIENT_REPLY);
        }
        // Refused with the free provider's own error type for as long as the journey holds it, then answered.
        if (prompt.includes("FREE")) return holding.has("FREE") ? refuse(response, 429, FREE_PROVIDER_MESSAGE, "FreeUsageLimitError", { "retry-after": "1" }) : streamReply(response, model, FREE_REPLY);
        if (prompt.includes("HARD")) return refuse(response, 400, "No endpoints found that support tool use. Try disabling tools.", "invalid_request_error");
        if (prompt.includes("SLOW")) return holdThenReply(response, model, SLOW_REPLY, SLOW_HOLD_MS, SLOW_OPENING);
        // Held while the journey says so — whatever request lands first — and answered once it lets go.
        if (prompt.includes("STOP")) return holding.has("STOP") ? holdThenReply(response, model, "Never sent.", 120_000) : streamReply(response, model, STOP_REPLY);
        if (prompt.includes("HOLD")) return holdThenReply(response, model, HOLD_REPLY, HOLD_MS);
        if (prompt.includes("CUT")) return holding.has("CUT") ? holdThenReply(response, model, "Never sent.", 90_000) : streamReply(response, model, CUT_REPLY);
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
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, requests, countFor, hold: (key) => holding.add(key), release: (key) => { holding.delete(key); if (key === "BACKGROUND") releaseBackground(); }, controlWorker: (id) => { controlledWorker = id; } };
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
  // Keep the profile outside this repository: OpenCode walks parent directories for project
  // configuration, and a profile under evals/results would inherit this checkout's own plugins and
  // MCPs — a slow first start that has nothing to do with a person's first launch.
  const profileDir = await mkdtemp(path.join(os.tmpdir(), "open-coworker-turn-recovery-profile-"));
  onTestFinished(() => rm(profileDir, { recursive: true, force: true }));
  await using app = await coworker({
    name: "turn-recovery",
    profileDir,
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
  await waitFor(app, `[...document.querySelectorAll('[data-message-role="assistant"]')].some((message) => (message.textContent ?? "").includes(${json(TRANSIENT_REPLY)})) || Boolean(document.querySelector('[data-testid="coworker-turn-failed"]'))`, { timeoutMs: 180_000, label: "the transient rate limit's outcome" });
  if (await evalIn(app, `Boolean(document.querySelector('[data-testid="coworker-turn-failed"]'))`)) {
    throw new Error(`A transient rate limit became a failure after ${scripted.countFor("TRANSIENT")} provider requests. ${await describeThread(app, serverUrl, ownerToken, workspaceId, await threadIdOf(), scripted)}`);
  }
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
      text: (failure.innerText ?? "").replace(technical instanceof HTMLElement ? technical.innerText : "", ""),
      className: failure.className,
      needsYou: failure.getAttribute("data-needs-you"),
      technicalShown: technical instanceof HTMLElement && technical.getBoundingClientRect().height > 0 && !(technical instanceof HTMLDetailsElement),
      technicalText: technical?.textContent ?? "",
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
  // The raw reason is part of the bubble from the start, small and bounded, so the bubble never grows; the words the person reads first stay plain.
  expect(hardCard.technicalShown).toBe(true);
  expect(String(hardCard.technicalText)).toMatch(/Technical details/);
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
    `The failure sat on Nova's side at the bubble's width with an amber dot and no rose, led with the headline, kept the provider's text small and bounded, and offered exactly A Use ${SECOND_MODEL_LABEL}, B Choose AI model, C Continue with OpenWork; the header, the thread status, and the rail all said the failure's own words. Choosing A switched Nova to ${SECOND_MODEL} and re-ran the same message id: the scripted model saw the prompt once per model, the engine holds one user message for it, and the conversation kept one user bubble plus a "Retried with" line.`,
    true,
  );
  await useFirstModel();

  // --- (b2) The free model's shared limit: named while the engine retries and once it gives up, never in the ---
  // --- engine's words, with the person's own AI provider as the way out; the app adds no attempts of its own. ---
  await waitForSettled(app);
  scripted.hold("FREE");
  await beginOutcomeTrace(app);
  await type(app, FREE_PROMPT);
  // While the engine retries: the quiet line names the free model, in the app's words, and offers the way out inline.
  const freeRetryLine = await waitFor(app, `(() => {
    const line = document.querySelector('[data-testid="coworker-turn-line"][data-outcome="retrying"]');
    if (!line) return false;
    return {
      text: line.textContent?.trim() ?? "",
      actions: [...line.querySelectorAll('[data-testid="coworker-turn-choice"]')].map((choice) => choice.getAttribute("data-choice")),
      header: document.querySelector('[data-testid="coworker-top-status"]')?.textContent?.trim() ?? "",
    };
  })()`, { timeoutMs: 90_000, label: "the free model's retry line" });
  if (!isRecord(freeRetryLine) || !Array.isArray(freeRetryLine.actions)) throw new Error("The retry line facts were unavailable.");
  expect(String(freeRetryLine.text)).toMatch(/^The free model is busy\. Trying again/);
  expect(String(freeRetryLine.text)).not.toMatch(/subscribe|OpenCode Go|Couldn't reach/i);
  expect(freeRetryLine.actions).toEqual(["stop", "connect-provider"]);
  expect(freeRetryLine.header).toBe("Retrying");
  // Once the engine gives up: one coworker-side message that names the free model and offers C Connect an AI provider.
  const freeCard = await waitFor(app, `(() => {
    const failure = document.querySelector('[data-testid="coworker-turn-failed"]');
    if (!failure || !failure.querySelector('[data-choice="use-model"]')) return false;
    const technical = failure.querySelector('[data-testid="coworker-turn-technical"]');
    const plain = failure.cloneNode(true);
    plain.querySelector('[data-testid="coworker-turn-technical"]')?.remove();
    return {
      headline: failure.querySelector('[data-testid="coworker-turn-headline"]')?.textContent?.trim() ?? "",
      text: plain.textContent ?? "",
      technicalShown: technical instanceof HTMLElement && technical.getBoundingClientRect().height > 0 && !(technical instanceof HTMLDetailsElement),
      technicalText: technical?.textContent ?? "",
      choices: [...failure.querySelectorAll('[data-testid="coworker-turn-choice"]')].map((choice) => ({ letter: choice.getAttribute("data-letter"), choice: choice.getAttribute("data-choice"), label: choice.textContent?.trim() ?? "" })),
      header: document.querySelector('[data-testid="coworker-top-status"]')?.textContent?.trim() ?? "",
      rail: document.querySelector('[data-testid="coworker-rail-line"]')?.textContent?.trim() ?? "",
    };
  })()`, { timeoutMs: 240_000, label: "the free model's limit as a coworker-side message" });
  if (!isRecord(freeCard) || !Array.isArray(freeCard.choices)) throw new Error("Free-limit card facts were unavailable.");
  const engineAttempts = scripted.countFor("FREE");
  expect(freeCard.headline).toBe("The free model is busy right now.");
  expect(String(freeCard.text)).toContain("The free model's shared usage limit was reached.");
  expect(String(freeCard.text)).toContain("OpenWork Models membership and your own AI providers");
  expect(String(freeCard.text)).not.toMatch(/faster|free credits|few minutes/);
  expect(String(freeCard.text)).toContain("Switching models is your choice.");
  expect(freeCard.technicalShown).toBe(true);
  // The plain explanation is separate from the bounded technical reason.
  expect(String(freeCard.text)).not.toMatch(/subscribe|OpenCode Go|FreeUsageLimitError|APIError|429/);
  expect(String(freeCard.technicalText)).toMatch(/FreeUsageLimitError|free_tier_limit/);
  // Another connected model can take over, so it leads; the third way is the one that ends the limit for good.
  expect(freeCard.choices.map((choice) => (isRecord(choice) ? `${choice.letter} ${choice.choice}` : ""))).toEqual(["A use-model", "B choose-model", "C connect-provider"]);
  const freeLabels = freeCard.choices.map((choice) => (isRecord(choice) ? String(choice.label) : ""));
  expect(freeLabels[0]).toContain(`Use ${SECOND_MODEL_LABEL}`);
  expect(freeLabels[1]).toContain("Choose AI model");
  expect(freeLabels[2]).toContain("Connect an AI provider");
  expect(freeCard.header).toBe("Reply failed");
  expect(freeCard.rail).toBe("The free model is busy right now.");
  // The app never runs its own 2/6/15 s attempts against the free model's limit: the count stays the engine's.
  await new Promise((resolve) => setTimeout(resolve, 16_000));
  expect(scripted.countFor("FREE")).toBe(engineAttempts);
  expect(engineAttempts).toBeGreaterThanOrEqual(2);
  expect(engineAttempts).toBeLessThanOrEqual(4);
  // C opens OpenWork › AI models — where the person's own provider is connected — and closing it keeps the failure in place.
  await evalIn(app, `document.querySelector('[data-testid="coworker-turn-choice"][data-choice="connect-provider"]').click(); true`);
  const providersScreen = await waitFor(app, `(() => {
    const pane = document.querySelector('[data-testid="openwork-settings-pane"]');
    const current = pane?.querySelector('[aria-current="page"]');
    const providers = pane?.querySelector('[data-testid="local-providers"]');
    if (!pane || pane.getAttribute("data-active") !== "true" || !current || !providers) return false;
    return { section: current.textContent?.trim() ?? "" };
  })()`, { timeoutMs: 30_000, label: "OpenWork settings open at AI models" });
  expect(isRecord(providersScreen) ? String(providersScreen.section) : "").toContain("AI models");
  await evalIn(app, `document.querySelector('button[aria-label="Close settings"]').click(); true`);
  // The settings pane stays mounted for continuity and only goes inactive; the discussion beneath still holds the failure.
  await waitFor(app, `document.querySelector('[data-testid="openwork-settings-pane"]')?.getAttribute("data-active") === "false" && Boolean(document.querySelector('[data-testid="coworker-turn-failed"]'))`, { timeoutMs: 30_000, label: "back in the discussion with the failure still there" });
  // A hands the same message to the other connected model; the reply lands, the failure goes, one receipt line stays.
  scripted.release("FREE");
  await evalIn(app, `document.querySelector('[data-testid="coworker-turn-choice"][data-choice="use-model"]').click(); true`);
  await waitForReply(app, SECOND_MODEL_REPLY, 120_000);
  // The conversation keeps one resolution note, the newest: this turn's "Retried with" replaces the earlier one.
  expect(await waitFor(app, `(() => {
    const lines = [...document.querySelectorAll('[data-testid="coworker-turn-line"][data-outcome="retried"]')].map((line) => line.textContent?.trim());
    return lines.length > 0 && document.querySelectorAll('[data-testid="coworker-turn-failed"]').length === 0 ? lines : false;
  })()`, { timeoutMs: 30_000, label: "the free-limit failure gone and the Retried with line in place" })).toEqual([`Retried with ${SECOND_MODEL_LABEL}`]);
  const freeTrace = await endOutcomeTrace(app);
  expect(freeTrace.outcomes).toContain("retrying");
  expect(freeTrace.outcomes).toContain("failed");
  expect(freeTrace.rails.some((line) => line.startsWith("The free model is busy."))).toBe(true);
  expect(freeTrace.rails.some((line) => line.startsWith("Couldn't reach the AI model."))).toBe(false);
  expect(scripted.requests.filter((request) => request.prompt.includes("FREE")).map((request) => request.model)).toEqual([...Array<string>(engineAttempts).fill(FIRST_MODEL), SECOND_MODEL]);
  const freeBubbles = await evalIn(app, USER_BUBBLES);
  expect(Array.isArray(freeBubbles) && freeBubbles.filter((text) => String(text).includes("FREE")).length).toBe(1);
  const afterFree = await engineUserMessages(serverUrl, ownerToken, workspaceId, threadId);
  expect(afterFree.filter((text) => text.includes("FREE"))).toHaveLength(1);
  evidence.recordAssertionEvidence(
    "The free model's shared limit is named as such while the engine retries and once it gives up, with connecting an AI provider as the way out, and the app adds no attempts of its own",
    `The scripted provider answered "FREE" with 429 and a FreeUsageLimitError body while held. The conversation's quiet line read "The free model is busy. Trying again…" with Stop and Connect an AI provider inline and the header said Retrying — never the engine's subscription copy. When the app bounded the exhausted free-tier loop after ${engineAttempts} attempts, one coworker-side message read "The free model is busy right now." with the plain explanation, exactly A Use ${SECOND_MODEL_LABEL}, B Choose AI model, C Connect an AI provider, the free-tier reason shown separately in bounded Technical details, and the header and rail agreed; sixteen seconds later the provider had still seen ${engineAttempts} requests, so the app ran none of its own 2/6/15 s attempts. C opened OpenWork settings at AI models; closing it returned to the discussion with the failure in place; A handed the same message to ${SECOND_MODEL}, whose reply landed as request ${engineAttempts + 1}, and the engine holds exactly one user message for it.`,
    true,
  );
  await useFirstModel();

  // --- (c) A reply held past the wait budget is still working, not a problem. -------------------------
  await waitForSettled(app);
  await beginOutcomeTrace(app);
  await type(app, SLOW_PROMPT);
  await waitUntilRunning(app, SLOW_PROMPT);
  // The first words stream into a real bubble the moment they arrive — before the part lands in the
  // transcript — so what is streaming is visible without a tap; the typing row is gone by then.
  const liveBubble = await waitFor(app, `(() => {
    const bubble = document.querySelector('[data-testid="coworker-live-bubble"]');
    if (!bubble || !(bubble.textContent ?? "").includes(${json(SLOW_OPENING)})) return false;
    return {
      text: bubble.textContent?.trim() ?? "",
      typingRow: Boolean(document.querySelector('[data-testid="coworker-typing"]')),
      landedBubbles: document.querySelectorAll('[data-testid="coworker-reply-bubble"]').length,
      header: document.querySelector('[data-testid="coworker-top-status"]')?.textContent?.trim() ?? "",
    };
  })()`, { timeoutMs: 30_000, label: "the words streaming into a live bubble" });
  expect(liveBubble).toMatchObject({ text: SLOW_OPENING, typingRow: false, header: "Working" });
  const slowRow = await waitFor(app, `(() => {
    const row = document.querySelector('[data-testid="coworker-working"][data-outcome="slow"]');
    if (!row) return false;
    return {
      phrase: row.querySelector('[data-testid="coworker-still-working"] > span')?.textContent?.trim() ?? "",
      stop: Boolean(row.querySelector('[data-testid="coworker-turn-choice"][data-choice="stop"]')),
      liveBubble: (document.querySelector('[data-testid="coworker-live-bubble"]')?.textContent ?? "").includes(${json(SLOW_OPENING)}),
      header: document.querySelector('[data-testid="coworker-top-status"]')?.textContent?.trim() ?? "",
      threadStatus: document.querySelector('[data-testid="coworker-thread-status"]')?.textContent?.trim() ?? "",
      rail: document.querySelector('[data-testid="coworker-rail-line"]')?.textContent?.trim() ?? "",
      failed: document.querySelectorAll('[data-testid="coworker-turn-failed"], [data-testid="coworker-turn-timeout"], [data-testid="coworker-turn-line"][data-outcome="failed"]').length,
    };
  })()`, { timeoutMs: SLOW_HOLD_MS + 30_000, label: "the live row softened past the wait budget" });
  expect(slowRow).toEqual({ phrase: "Nova is still working on it…", stop: true, liveBubble: true, header: "Still working", threadStatus: "Still working", rail: "Still working on it", failed: 0 });
  await waitForReply(app, SLOW_REPLY, 60_000);
  const slowTrace = await endOutcomeTrace(app);
  expect(slowTrace.outcomes).toContain("slow");
  expect(slowTrace.outcomes).not.toContain("failed");
  expect(slowTrace.headers).not.toContain("Response delayed");
  expect(slowTrace.headers).not.toContain("Reply failed");
  evidence.recordAssertionEvidence(
    "Two minutes without a reply is still working, in the same words everywhere, the words that did arrive are already in a bubble, and the reply then lands",
    `The scripted model sent its first words and then held the rest for ${SLOW_HOLD_MS / 1_000} s. The words that had arrived ("${SLOW_OPENING}") were already in a live bubble with the header on Working and no typing row. Past the wait budget the live row read "Nova is still working on it…" with one inline Stop, the header and thread status said Still working and the rail "Still working on it", nothing rose or card-shaped appeared, and the reply arrived afterwards.`,
    true,
  );

  // --- (d) Stop is one click away; Stopped. with Retry; Retry re-runs the same message. -------------
  await waitForSettled(app);
  scripted.hold("STOP");
  await type(app, STOP_PROMPT);
  await waitUntilRunning(app, STOP_PROMPT);
  await waitFor(app, `document.querySelector('[data-testid="coworker-send"]')?.getAttribute("data-role") === "stop"`, { timeoutMs: 30_000, label: "the round control became Stop" });
  await evalIn(app, `document.querySelector('[data-testid="coworker-send"][data-role="stop"]').click(); true`);
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
  scripted.release("STOP");
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
  expect(await evalIn(app, `document.querySelector('[data-testid="coworker-next-label"]')?.textContent ?? ""`)).toBe("Up next · 2 messages · sent after this reply");
  expect(await evalIn(app, `document.querySelectorAll('[data-testid="coworker-next-row"] button').length`)).toBe(2);
  expect(await evalIn(app, `document.querySelectorAll('[data-testid="coworker-next"] [role="menuitem"]').length`)).toBe(0);
  await screenshot(app);
  await evalIn(app, `document.querySelector('[data-testid="coworker-next-row"] [aria-haspopup="menu"]').click(); true`);
  await waitFor(app, `document.activeElement?.getAttribute("data-testid") === "coworker-next-edit"`, { label: "queue menu focuses its first action" });
  await evalIn(app, `document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); true`);
  expect(await evalIn(app, `document.activeElement?.getAttribute("data-testid")`)).toBe("coworker-next-send-now");
  await evalIn(app, `document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); true`);
  await waitFor(app, `document.activeElement?.getAttribute("aria-haspopup") === "menu" && !document.querySelector('[data-testid="coworker-next"] [role="menu"]')`, { label: "Escape returns focus to the queue action control" });
  // The record beside the coworker carries both: the turn in flight and what waits as Next.
  const turnsFile = await waitFor(app, `window.__COWORKER__.invoke("coworkers.files.read", { slug: "nova", path: "turns.json" })
    .then((response) => response.ok && response.result.content.includes("Next two") ? JSON.parse(response.result.content) : false)
    .catch(() => false)`, { timeoutMs: 30_000, label: "turns.json carries the pending turn and Next", awaitPromise: true });
  if (!isRecord(turnsFile) || !isRecord(turnsFile.threads) || !isRecord(turnsFile.threads[threadId])) throw new Error("turns.json did not name the thread.");
  const recorded = turnsFile.threads[threadId];
  expect(isRecord(recorded.pending) ? recorded.pending.prompt : null).toBe(HOLD_PROMPT);
  expect(Array.isArray(recorded.next) ? recorded.next.map((item) => (isRecord(item) ? item.text : null)) : null).toEqual(["Next one", "Next two"]);
  await evalIn(app, `[...document.querySelectorAll('[data-testid="coworker-next-row"]')][1].querySelector('[aria-haspopup="menu"]').click(); true`);
  await waitFor(app, `Boolean(document.querySelector('[data-testid="coworker-next-edit"]'))`, { label: "queue menu opens for edit" });
  await evalIn(app, `document.querySelector('[data-testid="coworker-next-edit"]').click(); true`);
  expect(await evalIn(app, `document.querySelector('textarea[aria-label="Message Nova"]')?.value`)).toBe("Next two");
  expect(await rows()).toEqual(["Next one"]);
  await type(app, "Next three");
  expect(await rows()).toEqual(["Next one", "Next three"]);
  await evalIn(app, `[...document.querySelectorAll('[data-testid="coworker-next-row"]')][1].querySelector('[aria-haspopup="menu"]').click(); true`);
  await waitFor(app, `Boolean(document.querySelector('[data-testid="coworker-next-remove"]'))`, { label: "queue menu opens for remove" });
  await evalIn(app, `document.querySelector('[data-testid="coworker-next-remove"]').click(); true`);
  expect(await rows()).toEqual(["Next one"]);
  await evalIn(app, `[...document.querySelectorAll('[data-testid="coworker-next-row"]')][0].querySelector('[aria-haspopup="menu"]').click(); true`);
  await waitFor(app, `Boolean(document.querySelector('[data-testid="coworker-next-send-now"]'))`, { label: "queue menu opens for send-now" });
  await evalIn(app, `document.querySelector('[data-testid="coworker-next-send-now"]').click(); true`);
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
    "With a reply held, two messages became two numbered rows under one Up next label, each with a single action menu; ArrowDown moved between actions and Escape closed the menu and restored focus, recorded in turns.json beside the pending turn; Edit returned the second to the field, a new one took its place, Remove dropped it, and Send now stopped the held reply (one quiet Stopped. line stayed in the transcript) and sent the waiting message at once. Two more messages then drained one at a time after the held reply landed, in order, each once.",
    true,
  );

  // --- (f) A turn cut off before it finished reads as such, Continue finishes it, and Next drains after. ---
  // The window's reload does not stop the engine by itself, so the engine's turn is interrupted while
  // the window is away — the same interruption a quit of the app produces — and the record on disk is
  // what the returning window reads.
  await waitForSettled(app);
  scripted.hold("CUT");
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
  scripted.release("CUT");
  // A hidden window can suspend paint callbacks. Work settlement must not wait for a paint.
  await evalIn(app, `window.__savedAnimationFrame = window.requestAnimationFrame; window.requestAnimationFrame = () => 0; true`);
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
  await evalIn(app, `window.requestAnimationFrame = window.__savedAnimationFrame; delete window.__savedAnimationFrame; true`);
  const afterCut = await engineUserMessages(serverUrl, ownerToken, workspaceId, threadId);
  expect(afterCut.filter((text) => text.includes("CUT"))).toHaveLength(1);
  expect(afterCut.at(-1)).toBe("After the cut");
  expect(await evalIn(app, `document.querySelectorAll('[data-testid="coworker-turn-line"][data-outcome="cut-off"]').length`)).toBe(0);
  evidence.recordAssertionEvidence(
    "A turn cut off before it finished reads as such after a reload, Continue finishes it under the same message id, and Next drains after",
    "With the reply held and one message waiting as Next, the window reloaded while the engine's turn was interrupted. The returning window read the record beside the coworker and showed one quiet line — Stopped when the app closed before Nova replied. · Continue · Discard — with the header saying Stopped and the rail the same line, the Next row still there, and no failure card. Continue re-ran the message under its own id and its reply landed even with animation frames suspended; the waiting message then went by itself, and the engine holds one user message for the cut turn.",
    true,
  );

});

test.skipIf(!enabled)("Open Coworker background work survives cancellation and restart", { timeout: 360_000 }, async ({ evidence }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"], commands: ["opencode"] });
  const scripted = await startScriptedModel();
  const profileDir = await mkdtemp(path.join(os.tmpdir(), "open-coworker-background-recovery-profile-"));
  onTestFinished(() => rm(profileDir, { recursive: true, force: true }));
  await using app = await coworker({ name: "background-recovery", profileDir });
  const created = resultRecord(await invokeCoworker(app, "coworkers.create", {
    name: "Nova", role: "Research partner", mission: "Keep research work moving.", avatarColor: "mint", avatarGlasses: "round",
  }));
  const workspaceId = String(created.workspaceId);
  const runtime = resultRecord(await invokeCoworker(app, "runtime.info", {}));
  const providerPatch = await fetch(`${runtime.serverUrl}/workspace/${encodeURIComponent(workspaceId)}/config`, {
    method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${runtime.ownerToken}` },
    body: JSON.stringify({ opencode: { provider: { [SCRIPTED_PROVIDER]: {
      npm: "@ai-sdk/openai-compatible", name: "Scripted models",
      options: { baseURL: scripted.baseUrl, apiKey: "eval-scripted-key" },
      models: { [FIRST_MODEL]: { name: "Scripted one", tool_call: true } },
    } } } }),
  });
  expect(providerPatch.status).toBe(200);
  const reload = await fetch(`${runtime.serverUrl}/workspace/${encodeURIComponent(workspaceId)}/engine/reload`, {
    method: "POST", headers: { Authorization: `Bearer ${runtime.ownerToken}` },
  });
  expect(reload.status).toBe(200);
  await invokeCoworker(app, "coworkers.update", { slug: "nova", patch: { model: `${SCRIPTED_PROVIDER}/${FIRST_MODEL}`, modelVariant: "" } });
  await evalIn(app, "location.reload(); true");
  await waitForNovaReady(app);
  await type(app, "Ready for background work.");
  await waitForReply(app, DEFAULT_REPLY);
  await waitForSettled(app);
  // Background work uses the same interruption contract, including a real
  // process restart. The controlled model witnesses tool permissions and
  // prompt delivery without contacting an external inference provider.
  await invokeCoworker(app, "settings.update", { maxParallelLocalRuns: 1 });
  const worker = resultRecord(await invokeCoworker(app, "workers.spawn", {
    slug: "nova", name: "Background check", goal: "BACKGROUND_RELIABILITY: compare the sources in bounded steps.", lifespan: { kind: "turns", max: 3 },
  }));
  const workerId = String(worker.id);
  scripted.controlWorker(workerId);
  await waitFor(app, `window.__COWORKER__.invoke("workers.get", { slug: "nova", id: ${json(workerId)} }).then(r => r.result?.threadId || false)`, { awaitPromise: true, timeoutMs: 90_000, label: "background native thread" });
  await expect.poll(() => scripted.requests.filter((request) => request.prompt.startsWith("You are a Worker") && request.prompt.includes("BACKGROUND_RELIABILITY")).length, { timeout: 30_000 }).toBe(1);
  const heldWorker = resultRecord(await invokeCoworker(app, "workers.get", { slug: "nova", id: workerId }));
  expect(heldWorker.status, String(heldWorker.error)).toBe("running");
  const assignment = resultRecord(await invokeCoworker(app, "localResponsibilities.create", {
    slug: "nova", name: "Cancelled queued check", instructions: "BACKGROUND_CANCELLED: this must not execute.", schedule: { kind: "once", timezone: "UTC", at: Date.now() + 86_400_000 },
  }));
  expect(resultRecord(await invokeCoworker(app, "localResponsibilities.runNow", { slug: "nova", id: assignment.id }))).toMatchObject({ accepted: true, queued: true });
  await invokeCoworker(app, "localResponsibilities.cancelQueued", { slug: "nova", id: assignment.id });
  await type(app, "Pause the background check for now.");
  await waitForReply(app, "The background check is paused.");
  scripted.release("BACKGROUND");
  await waitFor(app, `window.__COWORKER__.invoke("workers.get", { slug: "nova", id: ${json(workerId)} }).then(r => r.result?.status === "paused" && r.result?.lifespan?.used === 1)`, { awaitPromise: true, timeoutMs: 120_000, label: "pause holds after the current step" });
  await waitFor(app, `window.__COWORKER__.invoke("localResponsibilities.status", {}).then(r => r.result?.active === 0 && r.result?.queued === 0)`, { awaitPromise: true, timeoutMs: 30_000, label: "cancelled queue remains empty" });
  expect(scripted.countFor("BACKGROUND_CANCELLED")).toBe(0);
  const workerRequest = scripted.requests.find((request) => request.prompt.startsWith("You are a Worker") && request.prompt.includes("BACKGROUND_RELIABILITY"));
  expect(workerRequest?.tools).toContain("coworker_document_create");
  for (const forbidden of ["task", "coworker_worker_spawn", "coworker_worker_pause", "coworker_worker_resume", "coworker_assignment_create", "coworker_memory_note", "coworker_team_refer"]) {
    expect(workerRequest?.tools).not.toContain(forbidden);
  }
  expect(scripted.requests.find((request) => request.prompt === "Pause the background check for now.")?.tools).toContain("coworker_worker_pause");
  expect(await evalIn(app, `(document.body?.innerText ?? "").includes("Paused Background check")`)).toBe(true);
  await invokeCoworker(app, "workers.steer", { slug: "nova", id: workerId, text: "KEEP THIS STEERING: include source C.", });
  const interrupted = resultRecord(await invokeCoworker(app, "workers.spawn", {
    slug: "nova", name: "Interrupted check", goal: "BACKGROUND_INTERRUPTED: inspect the sources once.", lifespan: { kind: "turns", max: 2 },
  }));
  await waitFor(app, `window.__COWORKER__.invoke("workers.get", { slug: "nova", id: ${json(interrupted.id)} }).then(r => r.result?.threadId || false)`, { awaitPromise: true, timeoutMs: 90_000, label: "interrupted worker admitted" });
  await waitFor(app, `window.__COWORKER__.invoke("workers.get", { slug: "nova", id: ${json(interrupted.id)} }).then(async r => {
    const runtime = (await window.__COWORKER__.invoke("runtime.info")).result;
    const response = await fetch(runtime.serverUrl + "/workspace/" + ${json(workspaceId)} + "/opencode/session/" + r.result.threadId + "/message", { headers: { Authorization: "Bearer " + runtime.ownerToken } });
    const messages = await response.json();
    return messages.some(m => m.info.role === "assistant");
  })`, { awaitPromise: true, timeoutMs: 90_000, label: "interrupted turn reached the model" });
  await expect.poll(() => scripted.requests.filter((request) => request.prompt.startsWith("You are a Worker") && request.prompt.includes("BACKGROUND_INTERRUPTED")).length, { timeout: 30_000 }).toBe(1);
  await app.stop();
  await using restarted = await coworker({ name: "background-recovery", profileDir });
  expect(resultRecord(await invokeCoworker(restarted, "workers.get", { slug: "nova", id: workerId }))).toMatchObject({ status: "paused", steerCount: 1 });
  try {
    await waitFor(restarted, `window.__COWORKER__.invoke("workers.get", { slug: "nova", id: ${json(interrupted.id)} }).then(r => ["failed", "finished"].includes(r.result?.status))`, { awaitPromise: true, timeoutMs: 120_000, label: "interrupted work reconciled without another run" });
  } catch (error) {
    const state = resultRecord(await invokeCoworker(restarted, "workers.get", { slug: "nova", id: interrupted.id }));
    throw new Error(`${String(error)} Worker: ${JSON.stringify(state)}. Native requests: ${scripted.countFor("BACKGROUND_INTERRUPTED")}`);
  }
  expect(scripted.requests.filter((request) => request.prompt.startsWith("You are a Worker") && request.prompt.includes("BACKGROUND_INTERRUPTED"))).toHaveLength(1);
  await type(restarted, "Resume the background check.");
  await waitForReply(restarted, "The background check is resumed.");
  await waitFor(restarted, `window.__COWORKER__.invoke("workers.get", { slug: "nova", id: ${json(workerId)} }).then(r => r.result?.status === "finished" && r.result?.lifespan?.used === 2)`, { awaitPromise: true, timeoutMs: 120_000, label: "persisted steering delivered after restart" });
  expect(scripted.requests.filter((request) => request.prompt.startsWith("You are a Worker") && request.prompt.includes("KEEP THIS STEERING"))).toHaveLength(1);
  expect(scripted.countFor("BACKGROUND_CANCELLED")).toBe(0);
  const scheduled = resultRecord(await invokeCoworker(restarted, "localResponsibilities.create", {
    slug: "nova", name: "Scheduled completion", instructions: "BACKGROUND_SCHEDULED: report the completed check.",
    schedule: { kind: "once", timezone: "UTC", at: Date.now() + 10_000 },
  }));
  await waitFor(restarted, `window.__COWORKER__.invoke("localResponsibilities.list", { slug: "nova" }).then(r => r.result?.some(item => item.id === ${json(scheduled.id)} && item.latestRun?.status === "succeeded" && item.state === "paused" && item.runs.length === 1))`, { awaitPromise: true, timeoutMs: 90_000, label: "one scheduled occurrence completes once" });
  expect(scripted.countFor("BACKGROUND_SCHEDULED")).toBe(1);
  evidence.recordAssertionEvidence(
    "Background pause, queued cancellation, steering, and interrupted work survive a full app restart",
    "Chat invoked worker_pause and worker_resume through the native tools. Pause let exactly one step finish, the cancelled assignment never reached the model, and its queue stayed empty. A paused Worker's steering survived a process restart and was delivered once on Resume. Another Worker's accepted interrupted turn was not sent to the model again. Worker requests retained document tools but excluded direct Worker, assignment, memory, team management, and task delegation; coworker chat retained management tools. A one-time scheduled assignment then ran automatically, reached the model exactly once, succeeded, and paused its completed schedule.",
    true,
  );
});
