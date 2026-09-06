import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { clickButton, coworker, evalIn, fill, needs, test, waitFor } from "@openwork/testkit";
import { expect, onTestFinished } from "vitest";

/**
 * The live turn shows observed activity, never reasoning or tool payloads.
 * Preparing gets dots and inspectable execution time; tools get a safe category,
 * status and duration. Reply text streams without a duplicate indicator and
 * lands with its speed tooltip. A deterministic OpenAI-compatible model paces
 * each phase through the real native boundary, including a long wait.
 */

const enabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const title = enabled
  ? "Open Coworker's live turn exposes only observed activity: preparing dots, tool status and duration, streaming without duplicate indicators, and landed reply timing"
  : "Open Coworker live-turn journey skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1";

const SCRIPTED_PROVIDER = "eval-scripted";
const SCRIPTED_MODEL = "scripted";

const THINK_PROMPT = "Think it through: which of our three vendors should we keep?";
const THINK_REASONING = ["First the sources.", "Vendor A is cheapest but slow.", "Vendor B is steady.", "Vendor C has the best support.", "Steadiness matters most here.", "So: B, with C as the fallback."];
const THINK_REPLY = "Keep B. It is the steady one, and C makes a good fallback if B ever slips. A saves money but the delays would cost more than they save. I put the comparison in a short note so you can check the numbers yourself whenever you like.";
const TOOL_PROMPT = "Fetch our status page and tell me what it says.";
const TOOL_REPLY = "All clear — the status page says every service is up and nothing is scheduled. I will check it again before the vendor call in case that changes.";
const TOOL_UNKNOWN_PAYLOAD = "unrecognized-tool-payload-7c9f2a";
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

async function startScriptedModel(): Promise<{ baseUrl: string; prompts: string[]; toolInputReceived: boolean; toolOutputReceived: boolean }> {
  const state = { baseUrl: "", prompts: [] as string[], toolInputReceived: false, toolOutputReceived: false };
  const server = createServer((request, response) => {
    const url = request.url ?? "";
    if (request.method === "GET" && url.startsWith("/status-page")) {
      state.toolInputReceived = url.includes(TOOL_UNKNOWN_PAYLOAD);
      // A page that takes its time: the tool step in the conversation has a window a person can see.
      setTimeout(() => {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end(`Status: every service is up. Nothing scheduled.\n${JSON.stringify({ unrecognizedField: TOOL_UNKNOWN_PAYLOAD })}`);
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
            streamToolCall(response, "webfetch", { url: `${state.baseUrl.replace(/\/v1$/, "")}/status-page?unrecognizedField=${TOOL_UNKNOWN_PAYLOAD}`, format: "text" });
            return;
          }
          state.toolOutputReceived = isRecord(body) && Array.isArray(body.messages) && body.messages.some((message) => isRecord(message) && message.role === "tool" && JSON.stringify(message).includes(TOOL_UNKNOWN_PAYLOAD));
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

async function pressActivityKey(app: App, key: "Enter" | "Escape"): Promise<void> {
  for (const type of ["keyDown", "keyUp"]) {
    await app.client.send("Input.dispatchKeyEvent", { type, key, code: key, windowsVirtualKeyCode: key === "Enter" ? 13 : 27, ...(key === "Enter" && type === "keyDown" ? { text: "\r", unmodifiedText: "\r" } : {}) });
  }
}

/** Inspect the landed tool receipt with the keyboard, without growing the reply. */
async function readLandedWork(app: App): Promise<Record<string, unknown>> {
  await app.client.send("Page.bringToFront");
  const before = Number(await evalIn(app, `(() => {
    const line = document.querySelector('[data-testid="coworker-work-summary"]');
    const bubble = [...document.querySelectorAll('[data-testid="coworker-reply-bubble"]')].find((node) => node.textContent?.trim() === ${json(TOOL_REPLY)});
    line?.focus();
    return bubble?.getBoundingClientRect().height ?? 0;
  })()`));
  expect(before).toBeGreaterThan(0);
  await pressActivityKey(app, "Enter");
  const read = await waitFor(app, `(() => {
    const popover = document.querySelector('[data-testid="coworker-work-steps"][role="dialog"]');
    if (!popover || document.activeElement !== popover) return false;
    const bubble = [...document.querySelectorAll('[data-testid="coworker-reply-bubble"]')].find((node) => node.textContent?.trim() === ${json(TOOL_REPLY)});
    return {
      text: popover.textContent?.trim() ?? "",
      steps: [...popover.querySelectorAll('[data-testid="coworker-work-step"]')].map((step) => ({
        state: step.getAttribute("data-state"),
        kind: step.firstElementChild?.textContent?.trim() ?? "",
        details: Object.fromEntries([...step.querySelectorAll("dt")].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent?.trim() ?? ""])),
      })),
      expanded: document.querySelector('[data-testid="coworker-work-summary"]')?.getAttribute("aria-expanded"),
      height: bubble?.getBoundingClientRect().height ?? 0,
      ...${READ_PRIVACY},
    };
  })()`, { timeoutMs: 10_000, label: "keyboard focus in the landed execution popover" });
  if (!isRecord(read)) throw new Error("Execution popover facts were unavailable.");
  expect(read).toMatchObject({ expanded: "true", height: before, reasoningInDom: false, toolPayloadInDom: false });
  for (const thought of THINK_REASONING) expect(String(read.text)).not.toContain(thought);
  expect(String(read.text)).not.toContain(TOOL_UNKNOWN_PAYLOAD);
  await pressActivityKey(app, "Escape");
  await waitFor(app, `!document.querySelector('[data-testid="coworker-work-steps"]')
    && document.activeElement === document.querySelector('[data-testid="coworker-work-summary"]')
    && document.activeElement?.getAttribute("aria-expanded") === "false"`, { timeoutMs: 5_000, label: "Escape closes the execution popover and restores receipt focus" });
  return read;
}

async function waitForSettled(app: App, reply: string, timeoutMs = 120_000): Promise<void> {
  await waitFor(app, `[...document.querySelectorAll('[data-testid="coworker-reply-bubble"]')].some((bubble) => (bubble.textContent ?? "").includes(${json(reply)}))
    && document.querySelector('[data-testid="coworker-thread-status"]')?.dataset.state === "idle"
    && !document.querySelector('[data-testid="coworker-working"]')`, { timeoutMs, label: `the reply ${json(reply.slice(0, 24))} landed and the turn settled` });
  expect(await evalIn(app, READ_PRIVACY), "landed DOM contains neither raw reasoning nor unknown tool payloads").toEqual({ reasoningInDom: false, toolPayloadInDom: false });
}

// Inspect all markup, including hidden nodes and attributes, not just visible text.
const READ_PRIVACY = `(() => {
  const dom = document.body?.outerHTML ?? "";
  return { reasoningInDom: ${json(THINK_REASONING)}.some((thought) => dom.includes(thought)), toolPayloadInDom: dom.includes("unrecognizedField") || dom.includes(${json(TOOL_UNKNOWN_PAYLOAD)}) };
})()`;

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
    indicators: document.querySelectorAll('[data-testid="coworker-typing"], [data-testid="coworker-tool-chip"], [data-testid="coworker-activity-chip"]').length,
    rowHidden: row?.getAttribute("aria-hidden") === "true",
    rowText: row ? (row.firstElementChild?.textContent ?? "").trim() : "",
    note: row?.querySelector('[data-testid="coworker-still-working"]')?.textContent?.trim() ?? "",
    popover: popover ? {
      mode: popover.getAttribute("data-mode"),
      text: popover.textContent?.trim() ?? "",
      status: popover.querySelector("p")?.textContent?.trim() ?? "",
      smallPrint: popover.querySelector('[data-testid="coworker-thinking-small-print"]')?.textContent?.trim() ?? "",
      details: Object.fromEntries([...popover.querySelectorAll("dt")].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent?.trim() ?? ""])),
      technical: Boolean(popover.querySelector('pre, code, details, [data-testid="coworker-thinking-technical"]')),
    } : null,
    liveText: live ? (live.textContent ?? "").trim() : "",
    liveBubbles: document.querySelectorAll('[data-testid="coworker-live-bubble"]').length,
    landed: document.querySelectorAll('[data-testid="coworker-reply-bubble"]').length,
    header: document.querySelector('[data-testid="coworker-top-status"]')?.textContent?.trim() ?? "",
    rail: document.querySelector('[data-testid="coworker-rail-line"]')?.textContent?.trim() ?? "",
    ...${READ_PRIVACY},
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
      const entry = { at: Date.now(), ...live };
      if (!last || JSON.stringify({ ...last, at: 0 }) !== JSON.stringify({ ...entry, at: 0 })) trace.push(entry);
      const wantPhase = ${json(tap === "typing" ? "preparing" : "tool")};
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
  const trace = value.filter(isRecord);
  expect(trace.length).toBeGreaterThan(0);
  expect(trace.every((entry) => entry.reasoningInDom === false), "THINK_REASONING never appears in the live DOM, popover, or landed transcript").toBe(true);
  expect(trace.every((entry) => entry.toolPayloadInDom === false), "unknown tool payload never appears in the DOM, including inspection").toBe(true);
  const streaming = trace.filter((entry) => typeof entry.liveText === "string" && entry.liveText.length > 0);
  expect(streaming.every((entry) => entry.indicators === 0 && entry.rowText === "" && entry.popover === null && entry.liveBubbles === 1), "streaming has one live bubble and no duplicate activity indicator or popover").toBe(true);
  return trace;
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

  // --- 1. Preparing, then words: inspectable status, never reasoning; then a live bubble and landed timing.
  // The turn is quick, so what happened is read from a trace of the live shapes, not from separate waits.
  await beginLiveTrace(app, "typing");
  const sentAt = Date.now();
  await send(app, THINK_PROMPT);
  await waitForSettled(app, THINK_REPLY);
  const trace = await endLiveTrace(app);
  const preparingEntries = trace.filter((entry) => entry.phase === "preparing");
  const popoverEntries = trace.filter((entry) => entry.phase === "preparing" && isRecord(entry.popover));
  const writingEntries = trace.filter((entry) => typeof entry.liveText === "string" && entry.liveText.length > 0);
  const traceText = JSON.stringify(trace.map((entry) => ({ phase: entry.phase, typing: entry.typing, popover: isRecord(entry.popover) ? String(entry.popover.text).slice(0, 40) : null, live: String(entry.liveText).slice(-30), landed: entry.landed, header: entry.header, row: entry.rowText })));
  // Preparing keeps the typing bubble, no chip or reply words, and the steady header.
  expect(preparingEntries.length, traceText).toBeGreaterThan(0);
  expect(preparingEntries.every((entry) => entry.typing === true && entry.chip === "" && entry.liveText === "" && entry.rowText === "" && entry.header === "Working"), traceText).toBe(true);
  expect(popoverEntries.length, traceText).toBeGreaterThan(0);
  const popoverTexts = popoverEntries.map((entry) => (isRecord(entry.popover) ? String(entry.popover.text) : ""));
  expect(popoverEntries.every((entry) => isRecord(entry.popover) && entry.popover.mode === "execution" && entry.popover.status === "Preparing a reply" && entry.popover.technical === false), traceText).toBe(true);
  expect(popoverTexts.every((text) => text.includes("Only execution metadata. Reasoning and tool contents are not shown.")), traceText).toBe(true);
  for (const thought of THINK_REASONING) expect(popoverTexts.join("\n"), "raw reasoning is absent even with inspection open").not.toContain(thought);
  expect(popoverEntries.some((entry) => isRecord(entry.popover) && /^Execution: \d+ s elapsed$/.test(String(entry.popover.smallPrint))), traceText).toBe(true);
  // Words stream as a growing prefix with no typing bubble, popover, or landed reply yet.
  expect(writingEntries.length, traceText).toBeGreaterThan(1);
  expect(writingEntries.some((entry) => entry.phase === "writing" && entry.rowHidden === true), traceText).toBe(true);
  expect(writingEntries.every((entry) => entry.typing === false && entry.popover === null && entry.landed === 0 && THINK_REPLY.startsWith(String(entry.liveText).replace(/\s+$/, ""))), traceText).toBe(true);
  expect(String(writingEntries[writingEntries.length - 1]?.liveText).length).toBeGreaterThan(String(writingEntries[0]?.liveText).length);
  expect(trace.findIndex((entry) => isRecord(entry.popover) && entry.popover.status === "Preparing a reply")).toBeLessThan(trace.findIndex((entry) => typeof entry.liveText === "string" && entry.liveText.length > 0));
  const landed = await evalIn(app, `(() => {
    const bubbles = [...document.querySelectorAll('[data-message-role="assistant"]')];
    const reply = document.querySelector('[data-testid="coworker-reply-bubble"]');
    return {
      assistantBubbles: bubbles.filter((node) => node.querySelector(".bubble")).length,
      live: document.querySelectorAll('[data-live="true"]').length,
      text: reply?.textContent?.trim() ?? "",
      tooltip: reply?.getAttribute("title") ?? "",
      thinkingDisclosures: document.querySelectorAll('[data-testid="coworker-thinking"], [data-testid="coworker-thinking-landed-text"]').length,
    };
  })()`);
  expect(landed).toMatchObject({ assistantBubbles: 1, live: 0, text: THINK_REPLY, thinkingDisclosures: 0 });
  if (!isRecord(landed) || typeof landed.tooltip !== "string") throw new Error("Landed facts were unavailable.");
  expect(landed.tooltip).toMatch(/^Answered by eval-scripted\/scripted · first words in (under a second|\d+(\.\d)? s) · \d+(\.\d)? s in all$/);
  for (const thought of THINK_REASONING) expect(String(landed.text)).not.toContain(thought);
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
    "Preparing exposes observed execution time, never reasoning; words stream without duplicate indicators and land with reply timing",
    `The preparing row had dots, no chip or words, and header Working. Inspection showed Preparing a reply and elapsed execution time, with no technical fold or THINK_REASONING in any observed DOM. Streaming had one live bubble and no activity indicator or popover. The landed reply had no thinking disclosure and tooltip "${landed.tooltip}", with first words after roughly ${expectedThinkingMs / 1_000} s of scripted reasoning.`,
    true,
  );

  // --- 2. A real webfetch: only category, status and duration are inspectable, not its unknown payload.
  await beginLiveTrace(app, "chip");
  await send(app, TOOL_PROMPT);
  await waitForSettled(app, TOOL_REPLY);
  const toolTrace = await endLiveTrace(app);
  const toolText = JSON.stringify(toolTrace.map((entry) => ({ phase: entry.phase, typing: entry.typing, chip: entry.chip, popover: isRecord(entry.popover) ? { mode: entry.popover.mode, text: String(entry.popover.text).slice(0, 40), technical: entry.popover.technical } : null, live: String(entry.liveText).slice(-20) })));
  const chipEntries = toolTrace.filter((entry) => entry.phase === "tool");
  expect(chipEntries.length, toolText).toBeGreaterThan(0);
  expect(chipEntries.every((entry) => /^Web access: (Queued|Running)$/.test(String(entry.chip)) && entry.typing === false && entry.header === "Working"), toolText).toBe(true);
  expect(chipEntries.some((entry) => entry.chip === "Web access: Running"), toolText).toBe(true);
  const doingEntries = toolTrace.filter((entry) => entry.phase === "tool" && isRecord(entry.popover));
  expect(doingEntries.length, `the tool's execution popover: ${toolText}`).toBeGreaterThan(0);
  for (const entry of doingEntries) {
    expect(entry.popover).toMatchObject({ mode: "execution", status: "Using a tool", technical: false, text: expect.stringContaining("Web access") });
    expect(String(isRecord(entry.popover) ? entry.popover.text : "")).not.toContain(TOOL_UNKNOWN_PAYLOAD);
  }
  expect(doingEntries.some((entry) => isRecord(entry.popover) && isRecord(entry.popover.details) && entry.popover.details["Observed status"] === "Running" && /^\d+ s elapsed$/.test(String(entry.popover.details.Duration))), toolText).toBe(true);
  expect(toolTrace.some((entry) => entry.phase === "writing" && String(entry.liveText).startsWith("All clear")), toolText).toBe(true);
  expect(scripted.toolInputReceived, "the real webfetch received the unknown input field").toBe(true);
  expect(scripted.toolOutputReceived, "the provider received the real tool result containing the unknown field").toBe(true);
  const toolReceipt = await evalIn(app, `[...document.querySelectorAll('[data-testid="coworker-work-summary"]')].map((node) => node.textContent?.trim() ?? "").join(" | ")`);
  expect(String(toolReceipt).replace(/\s*›$/, "")).toBe("Web access: Completed");
  const landedWork = await readLandedWork(app);
  expect(landedWork.steps).toEqual([{ state: "completed", kind: "Web access", details: { "Observed status": "Completed", Duration: expect.stringMatching(/^\d+ s recorded$/) } }]);
  evidence.recordAssertionEvidence(
    "Tool inspection exposes category, observed status and duration without unrestricted payloads, and supports keyboard dismissal",
    `The real webfetch took ${SLOW_PAGE_MS / 1_000} s and carried an unknown field through input and output. The live chip showed Web access: Running, with no dots; inspection showed Using a tool, Running and elapsed duration. The landed receipt showed Web access: Completed with recorded duration. No observed DOM or popover exposed the unknown payload. Enter opened the landed receipt without growing the reply, and Escape closed it and restored focus.`,
    true,
  );

  // --- 3. A model without reasoning gets the same preparing status, not a claim about hidden thinking.
  await beginLiveTrace(app, "typing");
  await send(app, PLAIN_PROMPT);
  const plainDots = await waitFor(app, `(() => { const live = ${READ_LIVE}; return live.typing || live.liveText ? live : false; })()`, { timeoutMs: 60_000, label: "the plain reply's live shape" });
  if (isRecord(plainDots) && plainDots.typing === true) {
    expect(plainDots.phase).toBe("preparing");
    if (isRecord(plainDots.popover)) expect(plainDots.popover.status).toBe("Preparing a reply");
  }
  await waitForSettled(app, PLAIN_REPLY);
  const plainTrace = await endLiveTrace(app);
  for (const entry of plainTrace) {
    if (isRecord(entry.popover)) {
      expect(entry.popover).toMatchObject({ mode: "execution", technical: false });
      expect(String(entry.popover.text)).not.toMatch(/thinking out loud|doesn't share its thinking/);
    }
  }
  const plainLanded = await evalIn(app, `(() => ({
    thinkingDisclosures: document.querySelectorAll('[data-testid="coworker-thinking"]').length,
    tooltip: [...document.querySelectorAll('[data-testid="coworker-reply-bubble"]')].at(-1)?.getAttribute("title") ?? "",
  }))()`);
  expect(plainLanded).toMatchObject({ thinkingDisclosures: 0, tooltip: expect.stringMatching(/first words in (under a second|\d+(\.\d)? s) · \d+(\.\d)? s in all$/) });
  expect(String(isRecord(plainLanded) ? plainLanded.tooltip : "")).not.toContain("words of thinking");
  evidence.recordAssertionEvidence(
    "A model without reasoning keeps the normal preparing and streaming path and lands with timing, not a thinking disclosure",
    "The plain reply showed preparing dots (or went straight to words) and landed with no thinking disclosure. Any observed streaming had no duplicate indicator. Inspection made no claim about hidden thinking, and the tooltip kept first-words and total time without a words-of-thinking clause.",
    true,
  );

  // --- 4. Long preparation shows a deterministic note; the original wait budget still offers Stop.
  await beginLiveTrace(app, "typing");
  await send(app, SLOW_PROMPT);
  const long = await waitFor(app, `(() => { const live = ${READ_LIVE}; return live.phase === "preparing" && live.outcome === "slow" ? live : false; })()`, { timeoutMs: SLOW_HOLD_MS + 60_000, label: "the deterministic long-running note" });
  expect(long).toMatchObject({ phase: "preparing", typing: true, outcome: "slow", note: "Preparing a reply. 0 tool steps completed.", liveText: "", reasoningInDom: false, toolPayloadInDom: false });
  if (!await evalIn(app, `Boolean(document.querySelector('[data-testid="coworker-thinking-popover"]'))`)) {
    await evalIn(app, `document.querySelector('[data-testid="coworker-typing"]')?.focus(); true`);
    await pressActivityKey(app, "Enter");
  }
  await waitFor(app, `document.activeElement === document.querySelector('[data-testid="coworker-thinking-popover"][role="dialog"]')
    && document.querySelector('[data-testid="coworker-typing"]')?.getAttribute("aria-expanded") === "true"`, { timeoutMs: 5_000, label: "focus in live activity inspection" });
  await pressActivityKey(app, "Escape");
  await waitFor(app, `!document.querySelector('[data-testid="coworker-thinking-popover"]')
    && document.activeElement === document.querySelector('[data-testid="coworker-typing"]')
    && document.activeElement?.getAttribute("aria-expanded") === "false"`, { timeoutMs: 5_000, label: "Escape closes live inspection and restores typing-bubble focus" });
  const slow = await waitFor(app, `(() => { const live = ${READ_LIVE}; return live.outcome === "slow" && live.header === "Still working" && document.querySelector('[data-testid="coworker-working"] [data-testid="coworker-turn-choice"][data-choice="stop"]') ? live : false; })()`, { timeoutMs: SLOW_HOLD_MS + 60_000, label: "the row past the wait budget" });
  expect(slow).toMatchObject({ phase: "preparing", typing: true, outcome: "slow", header: "Still working", rail: "Still working on it", note: "Preparing a reply. 0 tool steps completed." });
  expect(await evalIn(app, `Boolean(document.querySelector('[data-testid="coworker-working"] [data-testid="coworker-turn-choice"][data-choice="stop"]'))`)).toBe(true);
  await waitForSettled(app, SLOW_REPLY, 90_000);
  const slowTrace = await endLiveTrace(app);
  const longEntries = slowTrace.filter((entry) => entry.phase === "preparing" && entry.outcome === "slow");
  expect(longEntries.length).toBeGreaterThan(1);
  expect(longEntries.every((entry) => entry.note === "Preparing a reply. 0 tool steps completed."), "elapsed time alone does not invent or change the progress note").toBe(true);
  expect(await evalIn(app, `document.querySelectorAll('[data-testid="coworker-turn-line"][data-outcome="failed"], [data-testid="coworker-turn-failed"]').length`)).toBe(0);
  evidence.recordAssertionEvidence(
    "Long preparation keeps a deterministic observed note, keyboard-accessible inspection and the existing wait-budget Stop action",
    `During the ${SLOW_HOLD_MS / 1_000} s hold, the long-running note stayed "Preparing a reply. 0 tool steps completed." Escape closed live inspection and restored focus. Past the original wait budget the header said Still working, the rail Still working on it, and inline Stop was available. Any observed streaming had no duplicate indicator; the reply landed with nothing marked failed.`,
    true,
  );

  // --- 5. Reload keeps timing and safe tool inspection, not raw reasoning or payloads.
  await evalIn(app, "location.reload(); true");
  await waitForNovaReady(app);
  const afterReload = await waitFor(app, `(() => {
    const bubbles = [...document.querySelectorAll('[data-testid="coworker-reply-bubble"]')];
    if (bubbles.length < 4) return false;
    return { tooltip: bubbles[0]?.getAttribute("title") ?? "", thinkingDisclosures: document.querySelectorAll('[data-testid="coworker-thinking"], [data-testid="coworker-thinking-landed-text"]').length, ...${READ_PRIVACY} };
  })()`, { timeoutMs: 60_000, label: "the replies after a reload" });
  expect(afterReload).toMatchObject({ tooltip: landed.tooltip, thinkingDisclosures: 0, reasoningInDom: false, toolPayloadInDom: false });
  expect((await readLandedWork(app)).steps).toEqual(landedWork.steps);
  evidence.recordAssertionEvidence(
    "Reload preserves reply timing and metadata-only tool inspection",
    `After reload the first reply's tooltip still read "${landed.tooltip}", there was no thinking disclosure or raw reasoning/payload in the DOM, and the completed web step retained its status and recorded duration behind keyboard-accessible inspection.`,
    true,
  );
});
