import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { clickButton, coworker, evalIn, fill, needs, test, waitFor } from "@openwork/testkit";
import { expect, onTestFinished } from "vitest";

/**
 * The live turn reads like someone typing. While the model thinks the row is a
 * typing bubble with no phrase, and a tap shows the thinking as it arrives;
 * while a tool runs the row is a chip in plain words; the moment the reply's
 * words start they stream into a real bubble, and once landed the bubble's
 * tooltip says how fast the reply came. A model that shares no thinking gets the
 * same dots and one honest line. A deterministic OpenAI-compatible model plays
 * the coworker's side and paces its stream so every phase can be seen.
 */

const enabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const title = enabled
  ? "Open Coworker's live turn reads like someone typing: dots while thinking with the thinking one tap away, a chip while a tool runs, words that stream into the bubble, and the speed in the tooltip"
  : "Open Coworker live-turn journey skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1";

const SCRIPTED_PROVIDER = "eval-scripted";
const SCRIPTED_MODEL = "scripted";

const THINK_PROMPT = "Think it through: which of our three vendors should we keep?";
const THINK_REASONING = ["First the sources.", "Vendor A is cheapest but slow.", "Vendor B is steady.", "Vendor C has the best support.", "Steadiness matters most here.", "So: B, with C as the fallback."];
const THINK_REPLY = "Keep B. It is the steady one, and C makes a good fallback if B ever slips. A saves money but the delays would cost more than they save. I put the comparison in a short note so you can check the numbers yourself whenever you like.";
const TOOL_PROMPT = "Fetch our status page and tell me what it says.";
const TOOL_REPLY = "All clear — the status page says every service is up and nothing is scheduled. I will check it again before the vendor call in case that changes.";
/** How long the scripted status page takes to answer, so the tool step has a window of its own. */
const SLOW_PAGE_MS = 3_500;
const PLAIN_PROMPT = "Quick one: what day is the vendor call?";
const PLAIN_REPLY = "Thursday at 10:30 your time, with Priya and Tom. Want me to add a prep note before then so nobody walks in cold?";
const SLOW_PROMPT = "Take your time with this one and hold before answering.";
const SLOW_REPLY = "Here it is, sorry for the wait — the numbers are in and the answer is B.";
/** The view's wait budget plus a margin; the same figure the coworker uses for "still working". */
const SLOW_HOLD_MS = 123_000;
const WORD_MS = 60;
const REASONING_CHUNK_MS = 450;

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
    request.on("data", (part: string) => { raw += part; });
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

function toolResults(body: unknown): number {
  if (!isRecord(body) || !Array.isArray(body.messages)) return 0;
  const lastUser = body.messages.map((message) => isRecord(message) && message.role === "user").lastIndexOf(true);
  return body.messages.slice(lastUser + 1).filter((message) => isRecord(message) && message.role === "tool").length;
}

function chunk(delta: Record<string, unknown>, finish: string | null): string {
  return `data: ${JSON.stringify({ id: "chatcmpl-scripted", object: "chat.completion.chunk", created: 1, model: SCRIPTED_MODEL, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Open the stream, optionally think out loud for a while, then the words one at a time, paced so a person (or a test) can see them arrive. */
async function streamPaced(response: ServerResponse, input: { reasoning?: string[]; text: string; holdMs?: number }): Promise<void> {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "close" });
  response.write(chunk({ role: "assistant" }, null));
  const alive = () => !response.writableEnded && !response.destroyed;
  if (input.holdMs) {
    // A model that is taking its time still produces a token now and then; a wholly silent stream is not how providers behave.
    const until = Date.now() + input.holdMs;
    while (alive() && Date.now() < until) {
      await sleep(Math.min(2_000, until - Date.now()));
      if (alive()) response.write(chunk({ content: " " }, null));
    }
  }
  for (const thought of input.reasoning ?? []) {
    if (!alive()) return;
    response.write(chunk({ reasoning_content: `${thought} ` }, null));
    await sleep(REASONING_CHUNK_MS);
  }
  for (const word of input.text.split(" ")) {
    if (!alive()) return;
    response.write(chunk({ content: `${word} ` }, null));
    await sleep(WORD_MS);
  }
  if (!alive()) return;
  response.write(chunk({}, "stop"));
  response.write("data: [DONE]\n\n");
  response.end();
}

function streamToolCall(response: ServerResponse, name: string, args: Record<string, unknown>): void {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "close" });
  response.write(chunk({ role: "assistant", content: null, tool_calls: [{ index: 0, id: `call_${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, null));
  response.write(chunk({}, "tool_calls"));
  response.write("data: [DONE]\n\n");
  response.end();
}

async function startScriptedModel(): Promise<{ baseUrl: string; prompts: string[] }> {
  const state = { baseUrl: "", prompts: [] as string[] };
  const server = createServer((request, response) => {
    const url = request.url ?? "";
    if (request.method === "GET" && url.startsWith("/status-page")) {
      // A page that takes its time: the tool step in the conversation has a window a person can see.
      setTimeout(() => {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("Status: every service is up. Nothing scheduled.");
      }, SLOW_PAGE_MS);
      return;
    }
    if (request.method === "GET" && url.startsWith("/v1/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: SCRIPTED_MODEL, object: "model" }] }));
      return;
    }
    if (request.method === "POST" && (url === "/v1/chat/completions" || url === "/chat/completions")) {
      void readBody(request).then((raw) => {
        let body: unknown = null;
        try { body = JSON.parse(raw); } catch { body = null; }
        const prompt = lastUserText(body);
        const results = toolResults(body);
        if (results === 0) state.prompts.push(prompt);
        if (prompt.includes("Think it through")) return streamPaced(response, { reasoning: THINK_REASONING, text: THINK_REPLY });
        if (prompt.includes("status page")) {
          if (results === 0) {
            streamToolCall(response, "webfetch", { url: `${state.baseUrl.replace(/\/v1$/, "")}/status-page`, format: "text" });
            return;
          }
          return streamPaced(response, { text: TOOL_REPLY });
        }
        if (prompt.includes("Quick one")) return streamPaced(response, { text: PLAIN_REPLY });
        if (prompt.includes("hold before answering")) return streamPaced(response, { text: SLOW_REPLY, holdMs: SLOW_HOLD_MS });
        return streamPaced(response, { text: "Okay." });
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
  state.baseUrl = `http://127.0.0.1:${address.port}/v1`;
  return state;
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
  await waitFor(app, `Boolean(document.querySelector('[data-testid="coworker-discussion-view"]') || document.querySelector('[data-testid="coworker-discussion-empty"]')) && [...document.querySelectorAll("h1")].some((heading) => heading.textContent?.trim() === "Nova")`, {
    timeoutMs: 120_000,
    label: "Nova's conversation",
  });
  await waitFor(app, `document.querySelector('[data-testid="coworker-top-status"]')?.textContent?.trim() === "Ready"`, { timeoutMs: 240_000, label: "Nova ready" });
}

async function send(app: App, prompt: string): Promise<void> {
  await fill(app, 'textarea[aria-label="Message Nova"]', prompt);
  await clickButton(app, "Send");
}

/** Open the first landed reply's "Thought through" line, read the thinking from its popover, and close it — measuring that the bubble did not grow. */
async function readLandedThinking(app: App): Promise<{ text: string; bubbleHeightBefore: number; bubbleHeightWhileOpen: number }> {
  const before = Number(await evalIn(app, `(() => {
    const line = document.querySelector('[data-testid="coworker-thinking"]');
    const bubble = line?.closest('[data-message-role="assistant"]');
    const height = bubble?.getBoundingClientRect().height ?? 0;
    line?.querySelector("button")?.click();
    return height;
  })()`));
  const read = await waitFor(app, `(() => {
    const popover = document.querySelector('[data-testid="coworker-details-popover"]');
    if (!popover) return false;
    const bubble = document.querySelector('[data-testid="coworker-thinking"]')?.closest('[data-message-role="assistant"]');
    return { text: popover.querySelector('[data-testid="coworker-thinking-landed-text"]')?.textContent?.trim() ?? "", height: bubble?.getBoundingClientRect().height ?? 0 };
  })()`, { timeoutMs: 10_000, label: "the thinking popover of a landed reply" });
  await evalIn(app, `document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); true`);
  await waitFor(app, `!document.querySelector('[data-testid="coworker-details-popover"]')`, { timeoutMs: 5_000, label: "the thinking popover closed" });
  if (!isRecord(read)) throw new Error("Thinking popover facts were unavailable.");
  return { text: String(read.text), bubbleHeightBefore: before, bubbleHeightWhileOpen: Number(read.height) };
}

async function waitForSettled(app: App, reply: string, timeoutMs = 120_000): Promise<void> {
  await waitFor(app, `[...document.querySelectorAll('[data-testid="coworker-reply-bubble"]')].some((bubble) => (bubble.textContent ?? "").includes(${json(reply)}))
    && document.querySelector('[data-testid="coworker-thread-status"]')?.dataset.state === "idle"
    && !document.querySelector('[data-testid="coworker-working"]')`, { timeoutMs, label: `the reply ${json(reply.slice(0, 24))} landed and the turn settled` });
}

/** What the live turn shows this instant. */
const READ_LIVE = `(() => {
  const row = document.querySelector('[data-testid="coworker-working"]');
  const popover = document.querySelector('[data-testid="coworker-thinking-popover"]');
  const live = document.querySelector('[data-testid="coworker-live-bubble"]');
  return {
    phase: row?.getAttribute("data-phase") ?? "",
    outcome: row?.getAttribute("data-outcome") ?? "",
    typing: Boolean(document.querySelector('[data-testid="coworker-typing"]')),
    chip: document.querySelector('[data-testid="coworker-tool-chip"]')?.textContent?.trim() ?? "",
    rowText: row ? (row.firstElementChild?.textContent ?? "").trim() : "",
    popover: popover ? {
      mode: popover.getAttribute("data-mode"),
      text: popover.querySelector('[data-testid="coworker-thinking-text"]')?.textContent?.trim() ?? "",
      smallPrint: popover.querySelector('[data-testid="coworker-thinking-small-print"]')?.textContent?.trim() ?? "",
      technical: Boolean(popover.querySelector('[data-testid="coworker-thinking-technical"]')),
    } : null,
    liveText: live ? (live.textContent ?? "").trim() : "",
    landed: document.querySelectorAll('[data-testid="coworker-reply-bubble"]').length,
    header: document.querySelector('[data-testid="coworker-top-status"]')?.textContent?.trim() ?? "",
    rail: document.querySelector('[data-testid="coworker-rail-line"]')?.textContent?.trim() ?? "",
  };
})()`;

/** Watch the live shapes as they change, and tap the typing bubble or the tool chip as soon as it shows, the way an impatient person would. */
async function beginLiveTrace(app: App, tap: "typing" | "chip"): Promise<void> {
  await evalIn(app, `(() => {
    window.__LIVE_TRACE__?.observer?.disconnect?.();
    const trace = [];
    const record = () => {
      const live = ${READ_LIVE};
      const last = trace[trace.length - 1];
      const entry = { at: Date.now(), phase: live.phase, typing: live.typing, chip: live.chip, popover: live.popover ? { mode: live.popover.mode, text: live.popover.text, smallPrint: live.popover.smallPrint, technical: live.popover.technical } : null, liveText: live.liveText, landed: live.landed, header: live.header, rowText: live.rowText };
      if (!last || JSON.stringify({ ...last, at: 0 }) !== JSON.stringify({ ...entry, at: 0 })) trace.push(entry);
      const wantPhase = ${json(tap === "typing" ? "thinking" : "tool")};
      const selector = ${json(tap === "typing" ? '[data-testid="coworker-typing"]' : '[data-testid="coworker-tool-chip"]')};
      if (live.phase !== wantPhase) window.__LIVE_TRACE__.tapped = false;
      if (live.phase === wantPhase && !live.popover && !window.__LIVE_TRACE__.tapped && document.querySelector(selector)) {
        window.__LIVE_TRACE__.tapped = true;
        document.querySelector(selector)?.click();
      }
    };
    const observer = new MutationObserver(record);
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    window.__LIVE_TRACE__ = { trace, observer, tapped: false };
    record();
    return true;
  })()`);
}

async function endLiveTrace(app: App): Promise<Record<string, unknown>[]> {
  const value = await evalIn(app, `(() => { const t = window.__LIVE_TRACE__; t?.observer?.disconnect?.(); return t?.trace ?? []; })()`);
  if (!Array.isArray(value)) throw new Error("The live trace was unavailable.");
  return value.filter(isRecord);
}

test.skipIf(!enabled)(title, { timeout: 1_200_000 }, async ({ evidence }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"], commands: ["opencode"] });
  const scripted = await startScriptedModel();
  // Keep the profile outside this repository: OpenCode walks parent directories for project
  // configuration, and a profile under evals/results would inherit this checkout's own plugins and
  // MCPs — a slow first start that has nothing to do with a person's first launch.
  const profileDir = await mkdtemp(path.join(os.tmpdir(), "open-coworker-live-turn-profile-"));
  onTestFinished(() => rm(profileDir, { recursive: true, force: true }));
  await using app = await coworker({
    name: "live-turn",
    profileDir,
    env: { ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", OPENROUTER_API_KEY: "", GEMINI_API_KEY: "", GOOGLE_API_KEY: "", XAI_API_KEY: "", GROQ_API_KEY: "", MISTRAL_API_KEY: "", DEEPSEEK_API_KEY: "" },
  });

  await waitFor(app, `(document.body?.innerText ?? "").toLowerCase().includes("welcome to open coworker")`, { timeoutMs: 120_000, label: "Open Coworker welcome screen" });
  const created = resultRecord(await invokeCoworker(app, "coworkers.create", { name: "Nova", role: "Research partner", mission: "Keep research work moving.", avatarColor: "mint", avatarGlasses: "round" }));
  const workspaceId = String(created.workspaceId);
  expect(workspaceId).not.toBe("");
  const runtime = resultRecord(await invokeCoworker(app, "runtime.info", {}));
  const serverUrl = String(runtime.serverUrl);
  const ownerToken = String(runtime.ownerToken);
  const providerPatch = await fetch(`${serverUrl}/workspace/${encodeURIComponent(workspaceId)}/config`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ opencode: { provider: { [SCRIPTED_PROVIDER]: { npm: "@ai-sdk/openai-compatible", name: "Scripted model", options: { baseURL: scripted.baseUrl, apiKey: "eval-scripted-key" }, models: { [SCRIPTED_MODEL]: { name: "Scripted model", tool_call: true } } } } } }),
  });
  expect(providerPatch.status).toBe(200);
  const engineReload = await fetch(`${serverUrl}/workspace/${encodeURIComponent(workspaceId)}/engine/reload`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ force: true }),
  });
  expect(engineReload.status).toBe(200);
  const deadline = Date.now() + 180_000;
  let connected = false;
  while (Date.now() < deadline && !connected) {
    const providers = await fetch(`${serverUrl}/workspace/${encodeURIComponent(workspaceId)}/opencode/provider`, { headers: { Authorization: `Bearer ${ownerToken}` } }).catch(() => null);
    const payload: unknown = providers?.ok ? await providers.json().catch(() => null) : null;
    connected = isRecord(payload) && Array.isArray(payload.connected) && payload.connected.includes(SCRIPTED_PROVIDER);
    if (!connected) await sleep(1_000);
  }
  expect(connected, "the engine lists the scripted provider as connected").toBe(true);
  await invokeCoworker(app, "coworkers.update", { slug: "nova", patch: { model: `${SCRIPTED_PROVIDER}/${SCRIPTED_MODEL}`, modelVariant: "" } });
  await evalIn(app, "location.reload(); true");
  await waitForNovaReady(app);
  const toolsConnected = await waitFor(app, `(async () => {
    const runtime = (await window.__COWORKER__.invoke("runtime.info")).result;
    const coworker = (await window.__COWORKER__.invoke("coworkers.get", { slug: "nova" })).result;
    const headers = { Authorization: "Bearer " + runtime.ownerToken };
    const base = runtime.serverUrl + "/workspace/" + encodeURIComponent(coworker.workspaceId);
    const engine = await fetch(base + "/opencode/mcp", { headers });
    if (!engine.ok) return false;
    const status = await engine.json();
    return status.coworker?.status === "connected" ? "connected" : false;
  })()`, { timeoutMs: 180_000, label: "Nova's tools connected", awaitPromise: true });
  expect(toolsConnected).toBe("connected");

  // --- 1. Thinking, then words: dots with no phrase; tap → the thinking arriving; then a live bubble; then the landed bubble with its speed.
  // The turn is quick, so what happened is read from a trace of the live shapes, not from separate waits.
  await beginLiveTrace(app, "typing");
  const sentAt = Date.now();
  await send(app, THINK_PROMPT);
  await waitForSettled(app, THINK_REPLY);
  const trace = await endLiveTrace(app);
  const thinkingEntries = trace.filter((entry) => entry.phase === "thinking");
  const popoverEntries = trace.filter((entry) => isRecord(entry.popover) && entry.popover.mode === "thinking");
  const writingEntries = trace.filter((entry) => typeof entry.liveText === "string" && entry.liveText.length > 0);
  const traceText = JSON.stringify(trace.map((entry) => ({ phase: entry.phase, typing: entry.typing, popover: isRecord(entry.popover) ? String(entry.popover.text).slice(0, 40) : null, live: String(entry.liveText).slice(-30), landed: entry.landed, header: entry.header, row: entry.rowText })));
  // While thinking: the typing bubble, no chip, no words, the header on its one steady word.
  expect(thinkingEntries.length, traceText).toBeGreaterThan(0);
  expect(thinkingEntries.every((entry) => entry.typing === true && entry.chip === "" && entry.liveText === "" && entry.rowText === "" && entry.header === "Working"), traceText).toBe(true);
  // The tap opened the popover on Thinking, and the thinking arrived in it while the model was still thinking.
  expect(popoverEntries.length, traceText).toBeGreaterThan(0);
  const popoverTexts = popoverEntries.map((entry) => (isRecord(entry.popover) ? String(entry.popover.text) : ""));
  expect(popoverTexts.some((text) => text.includes("First the sources.")), `popover texts: ${JSON.stringify(popoverTexts)}`).toBe(true);
  expect(popoverTexts.some((text) => text.includes("Vendor A is cheapest but slow.")), `the thinking grew: ${JSON.stringify(popoverTexts)}`).toBe(true);
  expect(popoverEntries.some((entry) => isRecord(entry.popover) && /^thinking for \d+ s$/.test(String(entry.popover.smallPrint))), traceText).toBe(true);
  expect(popoverEntries.every((entry) => entry.phase === "thinking"), "the popover was open only while thinking").toBe(true);
  // Then the words streamed into a live bubble — a growing prefix of the reply — with the typing bubble and popover gone and nothing landed yet.
  expect(writingEntries.length, traceText).toBeGreaterThan(1);
  expect(writingEntries.every((entry) => entry.typing === false && entry.popover === null && entry.landed === 0 && THINK_REPLY.startsWith(String(entry.liveText).replace(/\s+$/, ""))), traceText).toBe(true);
  expect(String(writingEntries[writingEntries.length - 1]?.liveText).length).toBeGreaterThan(String(writingEntries[0]?.liveText).length);
  // Thinking came before words.
  expect(trace.findIndex((entry) => isRecord(entry.popover) && String(entry.popover.text).includes("First the sources."))).toBeLessThan(trace.findIndex((entry) => typeof entry.liveText === "string" && entry.liveText.length > 0));
  const landed = await evalIn(app, `(() => {
    const bubbles = [...document.querySelectorAll('[data-message-role="assistant"]')];
    const reply = document.querySelector('[data-testid="coworker-reply-bubble"]');
    return {
      assistantBubbles: bubbles.filter((node) => node.querySelector(".bubble")).length,
      live: document.querySelectorAll('[data-live="true"]').length,
      text: reply?.textContent?.trim() ?? "",
      tooltip: reply?.getAttribute("title") ?? "",
      thoughtThrough: [...document.querySelectorAll('[data-testid="coworker-thinking"] button')].map((node) => node.textContent?.trim() ?? ""),
    };
  })()`);
  expect(landed).toMatchObject({ assistantBubbles: 1, live: 0, text: THINK_REPLY });
  if (!isRecord(landed) || typeof landed.tooltip !== "string" || !Array.isArray(landed.thoughtThrough)) throw new Error("Landed facts were unavailable.");
  expect(landed.tooltip).toMatch(/^Answered by eval-scripted\/scripted · first words in (under a second|\d+(\.\d)? s) · \d+(\.\d)? s in all$/);
  expect(landed.thoughtThrough.map((line) => String(line).replace(/\s*›$/, ""))).toEqual(["Thought through"]);
  // The thinking waits behind the line and opens over the transcript, not inside it: the bubble keeps the height it landed with.
  const thinkingRead = await readLandedThinking(app);
  expect(thinkingRead.text).toContain("Vendor B is steady.");
  expect(thinkingRead.bubbleHeightBefore).toBe(thinkingRead.bubbleHeightWhileOpen);
  const firstWordsMs = Number(/first words in (\d+(?:\.\d)?) s/.exec(landed.tooltip)?.[1] ?? "0") * 1_000;
  const expectedThinkingMs = THINK_REASONING.length * REASONING_CHUNK_MS;
  const speedFacts = await evalIn(app, `(async () => {
    const runtime = (await window.__COWORKER__.invoke("runtime.info")).result;
    const coworker = (await window.__COWORKER__.invoke("coworkers.get", { slug: "nova" })).result;
    const headers = { Authorization: "Bearer " + runtime.ownerToken };
    const messages = await fetch(runtime.serverUrl + "/workspace/" + encodeURIComponent(coworker.workspaceId) + "/opencode/session/" + encodeURIComponent(coworker.conversationThreadId) + "/message", { headers }).then((r) => r.json()).catch((e) => String(e));
    return {
      stored: window.localStorage.getItem("open-coworker.first-words.v1"),
      times: Array.isArray(messages) ? messages.map((m) => ({ id: m.info?.id, role: m.info?.role, created: m.info?.time?.created, completed: m.info?.time?.completed, parts: (m.parts ?? []).map((p) => [p.type, p.time?.start, p.time?.end]) })) : messages,
    };
  })()`, { awaitPromise: true, timeoutMs: 30_000 });
  expect(firstWordsMs, `tooltip ${json(landed.tooltip)} · facts ${json(speedFacts)} · test sentAt ${sentAt} · ${traceText}`).toBeGreaterThanOrEqual(expectedThinkingMs * 0.8);
  expect(firstWordsMs).toBeLessThan(Date.now() - sentAt + 1_000);
  evidence.recordAssertionEvidence(
    "While the model thinks the row is a typing bubble with no phrase, a tap shows the thinking arriving, the words then stream into a real bubble, and the landed reply's tooltip says how fast it came",
    `The trace of the live shapes showed the typing bubble with data-phase thinking, no chip and no words, the header on its one steady word Working; the tap opened the Thinking popover whose text grew from "First the sources" onward with small print "thinking for n s", only while thinking; when the reply's words started the popover was closed, the typing bubble gone, and a live bubble showed a growing prefix of the reply with nothing landed yet; once landed there was one bubble with the full reply, nothing live, "Thought through" holding the thinking, and the tooltip "${landed.tooltip}" — first words after roughly the ${expectedThinkingMs / 1_000} s of scripted thinking.`,
    true,
  );

  // --- 2. A tool: the row is a chip in plain words, never dots; tap → Doing with technical details. The coworker's own
  // tool answers in a moment, so the chip and its popover are read from a trace.
  await beginLiveTrace(app, "chip");
  await send(app, TOOL_PROMPT);
  await waitForSettled(app, TOOL_REPLY);
  const toolTrace = await endLiveTrace(app);
  const toolText = JSON.stringify(toolTrace.map((entry) => ({ phase: entry.phase, typing: entry.typing, chip: entry.chip, popover: isRecord(entry.popover) ? { mode: entry.popover.mode, text: String(entry.popover.text).slice(0, 40), technical: entry.popover.technical } : null, live: String(entry.liveText).slice(-20) })));
  const chipEntries = toolTrace.filter((entry) => entry.phase === "tool");
  expect(chipEntries.length, toolText).toBeGreaterThan(0);
  expect(chipEntries.every((entry) => entry.chip === "Reading a web page" && entry.typing === false && entry.header === "Working"), toolText).toBe(true);
  const doingEntries = toolTrace.filter((entry) => isRecord(entry.popover) && entry.popover.mode === "doing");
  // The popover on the chip, when the tap landed before the tool answered.
  if (doingEntries.length > 0) {
    expect(doingEntries.every((entry) => isRecord(entry.popover) && String(entry.popover.text).includes("Reading a web page") && entry.popover.technical === true), toolText).toBe(true);
  }
  expect(doingEntries.length, `the chip's popover on Doing: ${toolText}`).toBeGreaterThan(0);
  expect(toolTrace.some((entry) => entry.phase === "writing" && String(entry.liveText).startsWith("All clear")), toolText).toBe(true);
  const toolReceipt = await evalIn(app, `[...document.querySelectorAll('[data-testid="coworker-work-summary"]')].map((node) => node.textContent?.trim() ?? "").join(" | ")`);
  expect(String(toolReceipt)).toContain("Read a web page");
  evidence.recordAssertionEvidence(
    "While a tool runs the row is a chip that names the step in plain words, not dots",
    `The scripted status page took ${SLOW_PAGE_MS / 1_000} s to answer. The trace showed the row as the chip "Reading a web page" with data-phase tool and no typing bubble, the header on Working, the popover on it on Doing with the step and a Technical details fold; the reply then streamed into a live bubble and the receipt read Read a web page.`,
    true,
  );

  // --- 3. A model that shares no thinking: the same dots; once words arrive the popover says so in one line.
  await send(app, PLAIN_PROMPT);
  const plainDots = await waitFor(app, `(() => { const live = ${READ_LIVE}; return live.typing || live.liveText ? live : false; })()`, { timeoutMs: 60_000, label: "the plain reply's live shape" });
  if (isRecord(plainDots) && plainDots.typing === true) {
    await evalIn(app, `document.querySelector('[data-testid="coworker-typing"]')?.click(); true`);
    const notYet = await evalIn(app, `(() => { const live = ${READ_LIVE}; return live.popover?.text ?? ""; })()`);
    if (String(notYet)) expect(String(notYet)).toMatch(/^(Nova hasn't started thinking out loud yet\.|This AI model doesn't share its thinking\.)$/);
  }
  await waitForSettled(app, PLAIN_REPLY);
  const plainLanded = await evalIn(app, `(() => ({
    thoughtThrough: document.querySelectorAll('[data-testid="coworker-thinking"]').length,
    tooltip: [...document.querySelectorAll('[data-testid="coworker-reply-bubble"]')].at(-1)?.getAttribute("title") ?? "",
  }))()`);
  expect(plainLanded).toMatchObject({ thoughtThrough: 1, tooltip: expect.stringMatching(/first words in (under a second|\d+(\.\d)? s) · \d+(\.\d)? s in all$/) });
  expect(String(isRecord(plainLanded) ? plainLanded.tooltip : "")).not.toContain("words of thinking");
  evidence.recordAssertionEvidence(
    "A model that shares no thinking gets the same dots and no thinking fold, and its tooltip carries no thinking clause",
    `The plain reply showed the typing bubble (or went straight to words when it was quick), landed with only the earlier reply's "Thought through" fold on screen, and its tooltip said first words and total time with no words-of-thinking clause.`,
    true,
  );

  // --- 4. Slow: nothing arrives past the wait budget — the typing bubble stays, gains the soft phrase and Stop, then the words come.
  await send(app, SLOW_PROMPT);
  const slow = await waitFor(app, `(() => { const live = ${READ_LIVE}; return live.outcome === "slow" ? live : false; })()`, { timeoutMs: SLOW_HOLD_MS + 60_000, label: "the row past the wait budget" });
  expect(slow).toMatchObject({ phase: "thinking", typing: true, outcome: "slow", header: "Still working", rail: "Still working on it" });
  expect(String(isRecord(slow) ? slow.rowText : "")).toContain("Nova is still working on it…");
  expect(await evalIn(app, `Boolean(document.querySelector('[data-testid="coworker-working"] [data-testid="coworker-turn-choice"][data-choice="stop"]'))`)).toBe(true);
  await waitForSettled(app, SLOW_REPLY, 90_000);
  expect(await evalIn(app, `document.querySelectorAll('[data-testid="coworker-turn-line"][data-outcome="failed"], [data-testid="coworker-turn-failed"]').length`)).toBe(0);
  evidence.recordAssertionEvidence(
    "Past the wait budget with nothing arrived, the typing bubble stays and gains the soft phrase and Stop; the reply then lands",
    `After ${SLOW_HOLD_MS / 1_000} s without words the row still showed the typing bubble with data-outcome slow, the phrase "Nova is still working on it…" and an inline Stop, the header Still working and the rail "Still working on it"; the reply then landed with nothing marked failed.`,
    true,
  );

  // --- 5. A reload keeps the speed line and the thinking.
  await evalIn(app, "location.reload(); true");
  await waitForNovaReady(app);
  const afterReload = await waitFor(app, `(() => {
    const bubbles = [...document.querySelectorAll('[data-testid="coworker-reply-bubble"]')];
    if (bubbles.length < 4) return false;
    return { tooltip: bubbles[0]?.getAttribute("title") ?? "", thoughtThrough: document.querySelectorAll('[data-testid="coworker-thinking"]').length };
  })()`, { timeoutMs: 60_000, label: "the replies after a reload" });
  expect(afterReload).toMatchObject({ tooltip: landed.tooltip, thoughtThrough: 1 });
  expect((await readLandedThinking(app)).text).toContain("Vendor B is steady.");
  evidence.recordAssertionEvidence(
    "A reload keeps the speed line and the thinking",
    `After a reload the first reply's tooltip still read "${landed.tooltip}" and its "Thought through" fold still held the thinking.`,
    true,
  );
});
