import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { clickButton, coworker, evalIn, fill, needs, screenshot, test, waitFor, waitForText } from "@openwork/testkit";
import { expect, onTestFinished } from "vitest";

/**
 * A team that grows itself. Onboarding proposes a team from what the person
 * picks and creates it in one step; every coworker reads a description of its
 * team; one coworker offers to pass a request to the teammate whose job it is,
 * and the person's tap hands it over with a brief; a coworker proposes a new
 * teammate as a contact-style tile the person adds with one tap, or says not
 * now to — and the guards (a teammate already covers it, a recent decline)
 * leave no tile behind. A deterministic OpenAI-compatible model plays the
 * coworkers' side so every tool call is exact; everything else is the real
 * product path.
 *
 * Coverage gap: this team journey also needs private consultation -> visible
 * group answer -> one original-thread synthesis, and Worker yield -> one return
 * through the installed plugin. Only inference is scripted; user sends start
 * work and backend reads witness it. No collaboration records are seeded.
 */

const enabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const title = enabled
  ? "Open Coworker builds a team, hands work over, consults through a visible group and returns bounded Worker results to the original thread once"
  : "Open Coworker team journey skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1";

const SCRIPTED_PROVIDER = "eval-scripted";
const SCRIPTED_MODEL = "scripted";

const DRAFT_PROMPT = "Draft the launch announcement";
const DRAFT_REPLY = "Editor is better suited for this — want me to pass it over?";
const EDITOR_REPLY = "On it — a first draft of the announcement is coming.";
const PROOFREAD_PROMPT = "Proofread the pricing page";
const PROOFREAD_REPLY = "Editor could take this one — want me to pass it over?";
const KEPT_REPLY = "Understood — I'll proofread it myself.";
/** The same request again, in other letters and with a mark: the guard reads it as the same request. */
const PROOFREAD_AGAIN_PROMPT = "proofread the pricing page!";
const PROOFREAD_AGAIN_REPLY = "Right — I'm on it myself.";
const INBOX_PROMPT = "Can you keep an eye on the support inbox every morning?";
const INBOX_REPLY = "That's a job for a support coworker — want me to add one?";
const WRITER_PROMPT = "Add a writing coworker";
const WRITER_REPLY = "Editor already covers writing — want me to pass this to them?";
const SALES_PROMPT = "Who could handle our sales leads?";
const SALES_REPLY = "A sales coworker could own that — want me to add one?";
const SALES_AGAIN_PROMPT = "Anyone for the sales leads, then?";
const SALES_AGAIN_REPLY = "Understood, I'll leave that be for now.";

const PRIVATE_CANARY = "PRIVATE-NOVA-CANARY-73";
const CONSULT_PROMPT = `Ask Editor which launch headline fits the public brief, then bring me your recommendation here. Share only the public brief: a weekly planning tool for small teams. Keep this private note here: ${PRIVATE_CANARY}.`;
const CONSULT_QUESTION = "Which launch headline fits a weekly planning tool for small teams?";
const CONSULT_CONTEXT = "Public brief: a weekly planning tool for small teams.";
const CONSULT_OBJECTIVE = "Recommend a launch headline after Editor's consultation.";
const CONSULT_ACK = "I have asked Editor about the public brief and will bring the recommendation back here.";
const CONSULT_ANSWER = "Choose Plan the week together: it names the shared weekly outcome without an unsupported claim.";
const CONSULT_SYNTHESIS = "Editor's recommendation is Plan the week together. I recommend it because it matches the public brief without overstating the benefit.";
const WORKER_PROMPT = "Start one bounded Worker to check the supplied inventory and bring its finding back here. Inventory: three notebooks and two pens. Give it one turn.";
const WORKER_NAME = "Inventory check";
const WORKER_OBJECTIVE = "Review the bounded inventory check and report the total here.";
const WORKER_ACK = "I have started the inventory check and will review its finding here.";
const WORKER_FINDING = "The supplied inventory contains five items: three notebooks and two pens.";
const WORKER_SYNTHESIS = "I reviewed the Worker's inventory finding: five items in total, with no outside lookup needed.";
const FOREGROUND_PROMPT = "While that check runs, what is two plus two?";
const FOREGROUND_REPLY = "Two plus two is four.";
const CANCEL_PROMPT = "Start a separate one-turn Worker to check the supplied spare inventory: one folder. I may stop its follow-up.";
const CANCEL_NAME = "Spare inventory check";
const CANCEL_OBJECTIVE = "Review the spare inventory check here.";
const CANCEL_ACK = "I have started the spare inventory check.";
const CANCEL_FINDING = "The spare inventory contains one folder.";
const CANCEL_SYNTHESIS = "The spare inventory review is complete.";
const FOLLOW_UP = "Continue the original task using these requested results.";
const OTHER_DISCUSSION_PROMPT = "Keep this separate discussion for tomorrow's agenda.";
const OTHER_DISCUSSION_REPLY = "This discussion is for tomorrow's agenda.";
const PRIVATE_EDITOR_PROMPT = "Can you answer this private question while the consultation is running?";
const PRIVATE_EDITOR_REPLY = "Yes. This private reply is independent of the group consultation.";
const CANARY_PROMPT = "Write one counted line to continuation-canary.md, then confirm the receipt.";
const CANARY_CONTINUED = "The earlier counted line is kept. Only the missing confirmation is complete.";
const APPROVAL_PROMPT = "@editor Write one approved line to approval-canary.md, asking me first.";
const APPROVAL_REPLY = "The approved line was written once.";
const GROUP_QUESTION = "@editor Ask which direction the group should choose.";
const GROUP_CANCEL_QUESTION = "@editor Ask which direction to choose before I stop this step.";
const PRIVATE_QUESTION = "Ask my private-only question and wait here for my answer.";
const DIRECTION_QUESTION = { questions: [{ header: "Group direction", question: "Which direction should this group choose?", options: [{ label: "North", description: "The first route" }, { label: "South", description: "The second route" }], custom: false }] };

type GateName = "consultation" | "worker" | "foreground" | "cancelled-worker";
type ScriptedCall = { name: string; arguments: Record<string, unknown> };
type ScriptedTurn = { call: ScriptedCall | null; reply: string; gate?: GateName };

/** First match wins: a request passed on carries the original words too, so the hand-over line comes first. */
const SCRIPT: Array<{ match: string; turn: ScriptedTurn }> = [
  { match: "Continue the earlier private request.", turn: { call: null, reply: CANARY_CONTINUED } },
  { match: CANARY_PROMPT, turn: { call: { name: "bash", arguments: { command: "printf 'counted\\n' >> continuation-canary.md", description: "Write the continuation canary once" } }, reply: "Unreachable before explicit continuation" } },
  { match: APPROVAL_PROMPT, turn: { call: { name: "bash", arguments: { command: "printf 'approved\\n' >> approval-canary.md", description: "Write the group approval canary once" } }, reply: APPROVAL_REPLY } },
  { match: GROUP_QUESTION, turn: { call: { name: "question", arguments: DIRECTION_QUESTION }, reply: "The group chose North." } },
  { match: GROUP_CANCEL_QUESTION, turn: { call: { name: "question", arguments: DIRECTION_QUESTION }, reply: "This cancelled question must not complete." } },
  { match: PRIVATE_QUESTION, turn: { call: { name: "question", arguments: { questions: [{ header: "Private-only choice", question: "PRIVATE-QUESTION-CANARY: keep this in my discussion.", options: [{ label: "Private answer", description: "Not a group answer" }], custom: false }] } }, reply: "The private question was answered." } },
  { match: PRIVATE_EDITOR_PROMPT, turn: { call: null, reply: PRIVATE_EDITOR_REPLY } },
  { match: OTHER_DISCUSSION_PROMPT, turn: { call: null, reply: OTHER_DISCUSSION_REPLY } },
  { match: `Objective: ${CONSULT_OBJECTIVE}`, turn: { call: null, reply: CONSULT_SYNTHESIS } },
  { match: `Objective: ${WORKER_OBJECTIVE}`, turn: { call: null, reply: WORKER_SYNTHESIS } },
  { match: `Objective: ${CANCEL_OBJECTIVE}`, turn: { call: null, reply: CANCEL_SYNTHESIS } },
  { match: `Question: ${CONSULT_QUESTION}`, turn: { call: null, reply: CONSULT_ANSWER, gate: "consultation" } },
  { match: `You are a Worker named "${WORKER_NAME}"`, turn: { call: null, reply: `## Done\n${WORKER_FINDING}`, gate: "worker" } },
  { match: `You are a Worker named "${CANCEL_NAME}"`, turn: { call: null, reply: `## Done\n${CANCEL_FINDING}`, gate: "cancelled-worker" } },
  { match: FOREGROUND_PROMPT, turn: { call: null, reply: FOREGROUND_REPLY, gate: "foreground" } },
  {
    match: CONSULT_PROMPT,
    turn: {
      call: { name: "coworker_team_consult", arguments: {
        to: "editor", question: CONSULT_QUESTION, context: CONSULT_CONTEXT,
        continuation: { objective: CONSULT_OBJECTIVE, refs: ["public launch brief"], completedActions: ["Shared the public brief with Editor"], resumeInstructions: "Evaluate Editor's answer and recommend a headline here without asking again." },
      } },
      reply: CONSULT_ACK,
    },
  },
  {
    match: WORKER_PROMPT,
    turn: {
      call: { name: "coworker_worker_spawn", arguments: {
        name: WORKER_NAME, goal: "Count the supplied inventory: three notebooks and two pens. Report the total; no tools or outside lookup are needed.", lifespan: { kind: "turns", turns: 1 },
        continuation: { objective: WORKER_OBJECTIVE, completedActions: ["Delegated the supplied inventory count"], resumeInstructions: "Check the finding against the supplied inventory and report the total here. Do not start another Worker." },
      } },
      reply: WORKER_ACK,
    },
  },
  {
    match: CANCEL_PROMPT,
    turn: {
      call: { name: "coworker_worker_spawn", arguments: {
        name: CANCEL_NAME, goal: "Count the supplied spare inventory: one folder. No tools or outside lookup are needed.", lifespan: { kind: "turns", turns: 1 },
        continuation: { objective: CANCEL_OBJECTIVE, resumeInstructions: "Review the spare inventory finding here." },
      } },
      reply: CANCEL_ACK,
    },
  },
  { match: "Passed from Nova", turn: { call: null, reply: EDITOR_REPLY } },
  { match: "Go ahead, Nova", turn: { call: null, reply: KEPT_REPLY } },
  {
    match: PROOFREAD_AGAIN_PROMPT,
    turn: {
      call: { name: "coworker_team_refer", arguments: { to: "editor", message: PROOFREAD_AGAIN_PROMPT, why: "Editor edits for a living." } },
      reply: PROOFREAD_AGAIN_REPLY,
    },
  },
  {
    match: PROOFREAD_PROMPT,
    turn: {
      call: { name: "coworker_team_refer", arguments: { to: "editor", message: PROOFREAD_PROMPT, why: "Editor edits for a living." } },
      reply: PROOFREAD_REPLY,
    },
  },
  {
    match: DRAFT_PROMPT,
    turn: {
      call: { name: "coworker_team_refer", arguments: { to: "editor", message: DRAFT_PROMPT, why: "Editor writes for a living." } },
      reply: DRAFT_REPLY,
    },
  },
  {
    match: "support inbox every morning",
    turn: {
      call: { name: "coworker_team_suggest", arguments: { role: "support", mission: "I watch the inbox and answer with care.", why: "the support inbox comes up every morning" } },
      reply: INBOX_REPLY,
    },
  },
  {
    match: WRITER_PROMPT,
    turn: {
      call: { name: "coworker_team_suggest", arguments: { role: "writing", mission: "I write.", why: "you asked for a writer" } },
      reply: WRITER_REPLY,
    },
  },
  {
    match: SALES_PROMPT,
    turn: {
      call: { name: "coworker_team_suggest", arguments: { role: "sales", mission: "I keep leads warm and follow up on time.", why: "the sales leads keep coming up" } },
      reply: SALES_REPLY,
    },
  },
  {
    match: SALES_AGAIN_PROMPT,
    turn: {
      call: { name: "coworker_team_suggest", arguments: { role: "sales", mission: "I keep leads warm and follow up on time.", why: "the sales leads came up again" } },
      reply: SALES_AGAIN_REPLY,
    },
  },
];

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

function toolResults(body: unknown): string[] {
  if (!isRecord(body) || !Array.isArray(body.messages)) return [];
  const lastUser = body.messages.map((message) => isRecord(message) && message.role === "user").lastIndexOf(true);
  return body.messages
    .slice(lastUser + 1)
    .filter((message): message is Record<string, unknown> => isRecord(message) && message.role === "tool")
    .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)));
}

/** What one request tells about the instruction stack the model received: the system prompt's size and what it carries, and the tools offered. */
type PromptFacts = { systemChars: number; contractInPrompt: boolean; toolServerLineInPrompt: boolean; tools: number; toolNames: string[]; privateCanary: boolean; bodyChars: number; prompt: string; reasoningEffort: string };

function promptFacts(body: unknown, raw: string, prompt: string): PromptFacts {
  const system = isRecord(body) && Array.isArray(body.messages)
    ? body.messages
      .filter((message): message is Record<string, unknown> => isRecord(message) && message.role === "system")
      .map((message) => (typeof message.content === "string" ? message.content : Array.isArray(message.content) ? message.content.map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : "")).join("\n") : ""))
      .join("\n")
    : "";
  return {
    systemChars: system.length,
    contractInPrompt: system.includes("Which shape an answer takes"),
    toolServerLineInPrompt: system.includes("Open Coworker's own tools for this coworker"),
    tools: isRecord(body) && Array.isArray(body.tools) ? body.tools.length : 0,
    toolNames: isRecord(body) && Array.isArray(body.tools) ? body.tools.flatMap((entry) => isRecord(entry) && isRecord(entry.function) && typeof entry.function.name === "string" ? [entry.function.name] : []) : [],
    privateCanary: raw.includes(PRIVATE_CANARY),
    bodyChars: raw.length,
    prompt,
    // The thinking effort as the provider receives it (the "high" variant declared on the scripted model).
    reasoningEffort: isRecord(body) && typeof body.reasoning_effort === "string" ? body.reasoning_effort : "",
  };
}

function streamChunks(response: ServerResponse, deltas: Array<Record<string, unknown>>, finish: string): void {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const base = { id: "chatcmpl-scripted", object: "chat.completion.chunk", created: 1, model: SCRIPTED_MODEL };
  for (const delta of deltas) response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`);
  response.write("data: [DONE]\n\n");
  response.end();
}

async function startScriptedModel() {
  const held = new Map<GateName, { response: ServerResponse; reply: string; timer: ReturnType<typeof setTimeout> }>();
  const gated = new Set<GateName>();
  const state: { baseUrl: string; seenToolResults: string[]; prompts: string[]; facts: PromptFacts[]; errors: string[] } = { baseUrl: "", seenToolResults: [], prompts: [], facts: [], errors: [] };
  const server = createServer((request, response) => {
    const url = request.url ?? "";
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
        const groupMarker = "\nThe person's message: ";
        const groupStart = prompt.lastIndexOf(groupMarker);
        const currentRequest = groupStart >= 0 ? prompt.slice(groupStart + groupMarker.length) : prompt;
        const scripted = SCRIPT.find((entry) => currentRequest.includes(entry.match));
        const results = toolResults(body);
        state.seenToolResults.push(...results);
        if (prompt === CANARY_PROMPT && results.length > 0) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: "Interrupted after the canary write. Review the completed action before continuing.", type: "interrupted_execution" } }));
          return;
        }
        if (results.length === 0) {
          state.prompts.push(prompt);
          state.facts.push(promptFacts(body, raw, prompt));
        }
        if (scripted?.turn.call && results.length === 0) {
          const call = scripted.turn.call;
          streamChunks(response, [{
            role: "assistant",
            content: null,
            tool_calls: [{ index: 0, id: `call_${call.name}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }],
          }], "tool_calls");
          return;
        }
        if (scripted?.turn.gate) {
          const { gate, reply } = scripted.turn;
          if (gated.has(gate)) {
            state.errors.push(`Duplicate inference request for ${gate}`);
            response.writeHead(409).end();
            return;
          }
          gated.add(gate);
          // Hold the provider response, never product state. A forgotten gate fails
          // closed rather than releasing an answer on a timing-dependent sleep.
          const timer = setTimeout(() => {
            state.errors.push(`Response gate expired: ${gate}`);
            held.delete(gate);
            response.destroy();
          }, 180_000);
          held.set(gate, { response, reply, timer });
          return;
        }
        streamChunks(response, [{ role: "assistant" }, { content: scripted?.turn.reply ?? "Okay." }], "stop");
      }).catch(() => { state.errors.push("Scripted request failed"); response.destroy(); });
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
    for (const { timer } of held.values()) clearTimeout(timer);
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Scripted model did not bind a TCP port.");
  state.baseUrl = `http://127.0.0.1:${address.port}/v1`;
  return { ...state, held, release(gate: GateName, cancelled = false) {
    const pending = held.get(gate);
    if (!pending) throw new Error(`No held response for ${gate}`);
    held.delete(gate);
    clearTimeout(pending.timer);
    if (pending.response.destroyed) {
      if (!cancelled) throw new Error(`The ${gate} response was abandoned before release`);
      return;
    }
    streamChunks(pending.response, [{ role: "assistant" }, { content: pending.reply }], "stop");
  } };
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

function resultList(response: unknown): Record<string, unknown>[] {
  if (!isRecord(response) || response.ok !== true || !Array.isArray(response.result)) {
    throw new Error(`Open Coworker bridge returned an unexpected response: ${JSON.stringify(response)}`);
  }
  return response.result.filter(isRecord);
}

function resultText(response: unknown): string {
  const record = resultRecord(response);
  return typeof record.content === "string" ? record.content : "";
}

async function waitForConversation(app: App, name: string, ready = true): Promise<void> {
  await waitFor(app, `Boolean(document.querySelector('[data-testid="coworker-discussion-view"]') || document.querySelector('[data-testid="coworker-discussion-empty"]')) && [...document.querySelectorAll("h1")].some((heading) => heading.textContent?.trim() === ${json(name)})`, {
    timeoutMs: 120_000,
    label: `${name}'s conversation`,
  });
  if (ready) await waitFor(app, `document.querySelector('[data-testid="coworker-top-status"]')?.textContent?.trim() === "Ready"`, { timeoutMs: 240_000, label: `${name} ready` });
}

/** The engine has connected to this coworker's own tools; the first message never races the registration. */
async function waitForTools(app: App, slug: string): Promise<void> {
  const connected = await waitFor(app, `(async () => {
    const runtime = (await window.__COWORKER__.invoke("runtime.info")).result;
    const coworker = (await window.__COWORKER__.invoke("coworkers.get", { slug: ${json(slug)} })).result;
    const headers = { Authorization: "Bearer " + runtime.ownerToken };
    const base = runtime.serverUrl + "/workspace/" + encodeURIComponent(coworker.workspaceId);
    const registration = await fetch(base + "/mcp", { headers });
    if (!registration.ok) return false;
    const payload = await registration.json();
    if (!(payload.items ?? []).some((item) => item.name === "coworker")) return false;
    const engine = await fetch(base + "/opencode/mcp", { headers });
    if (!engine.ok) return false;
    const status = await engine.json();
    return status.coworker?.status === "connected" ? "connected" : false;
  })()`, { timeoutMs: 180_000, label: `${slug}'s tools connected`, awaitPromise: true });
  expect(connected).toBe("connected");
}

/** Send one message and wait for the reply; returns the settled action line's collapsed words. */
async function converse(app: App, name: string, prompt: string, reply: string, alreadySent = false): Promise<{ summary: string; steps: string[]; text: string }> {
  if (!alreadySent) {
    await fill(app, `textarea[aria-label=${json(`Message ${name}`)}]`, prompt);
    await clickButton(app, "Send");
  }
  await waitFor(app, `[...document.querySelectorAll('[data-message-role="assistant"]')].some((message) => (message.textContent ?? "").includes(${json(reply)}))`, {
    timeoutMs: 300_000,
    label: `reply ${json(reply)}`,
  });
  try {
    await waitFor(app, `document.querySelector('[data-testid="coworker-thread-status"]')?.dataset.state === "idle" && !document.querySelector('[data-testid="coworker-working"]')`, {
      timeoutMs: 120_000,
      label: "the turn settled",
    });
  } catch (error) {
    // Say what the engine and the view each believe, so a parked turn can be told from a hung one.
    const diagnostics = await evalIn(app, `(async () => {
      const runtime = (await window.__COWORKER__.invoke("runtime.info")).result;
      const coworkers = (await window.__COWORKER__.invoke("coworkers.list")).result;
      const current = coworkers.find((member) => member.name === ${json(name)});
      const headers = { Authorization: "Bearer " + runtime.ownerToken };
      const sessions = await fetch(runtime.serverUrl + "/workspace/" + encodeURIComponent(current.workspaceId) + "/opencode/session", { headers }).then((response) => response.json()).catch((cause) => String(cause));
      const status = document.querySelector('[data-testid="coworker-thread-status"]');
      return {
        view: { state: status?.dataset.state, outcome: status?.dataset.outcome, text: status?.textContent, hidden: document.hidden, hasFocus: document.hasFocus() },
        sessions: Array.isArray(sessions) ? sessions.map((session) => ({ id: session.id, title: session.title, status: session.status, updated: session.time?.updated })) : sessions,
      };
    })()`, { awaitPromise: true, timeoutMs: 30_000 }).catch((cause: unknown) => String(cause));
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n\nSettle diagnostics: ${JSON.stringify(diagnostics)}`, { cause: error });
  }
  const facts = await waitFor(app, `(() => {
    const bubbles = [...document.querySelectorAll('[data-message-role]')];
    const userIndex = bubbles.findIndex((bubble) => (bubble.textContent ?? "").includes(${json(prompt)}));
    const replyIndex = bubbles.findIndex((bubble) => (bubble.textContent ?? "").includes(${json(reply)}));
    if (userIndex === -1 || replyIndex === -1) return false;
    const top = bubbles[userIndex].getBoundingClientRect().bottom;
    const bottom = bubbles[replyIndex].getBoundingClientRect().top;
    const line = [...document.querySelectorAll('[data-testid="coworker-action-line"]')].find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return rect.top >= top - 1 && rect.bottom <= bottom + 1;
    });
    const receipt = line?.querySelector('[data-testid="coworker-work-receipt"]');
    if (!(line instanceof HTMLElement) || !(receipt instanceof HTMLElement) || receipt.dataset.state !== "done") return false;
    const summary = line.querySelector('[data-testid="coworker-work-summary"]');
    if (summary instanceof HTMLElement && summary.getAttribute("aria-expanded") !== "true") summary.click();
    return {
      summary: summary?.querySelector("span")?.textContent?.trim() ?? "",
      steps: [...line.querySelectorAll('[data-testid="coworker-work-step"]')].map((step) => step.querySelector("p")?.textContent?.trim() ?? ""),
      text: line.innerText,
    };
  })()`, { timeoutMs: 60_000, label: `the action line between ${json(prompt)} and its reply` });
  if (!isRecord(facts) || typeof facts.summary !== "string" || !Array.isArray(facts.steps) || typeof facts.text !== "string") {
    throw new Error("Action line facts were unavailable.");
  }
  return { summary: facts.summary, steps: facts.steps.map(String), text: facts.text };
}

/** The team tiles on screen, as the person sees them: kind, state, name plate, small print, and the pills' printed words. */
const READ_TILES = `[...document.querySelectorAll('[data-testid="teammate-card"]')].map((tile) => {
  const pills = tile.parentElement?.querySelector('[data-testid="teammate-choices"]');
  return {
    kind: tile.dataset.kind,
    state: tile.dataset.state,
    name: tile.querySelector('[data-testid="teammate-card-name"]')?.textContent?.trim() ?? "",
    role: tile.querySelector('[data-testid="teammate-card-role"]')?.textContent?.trim() ?? "",
    mission: tile.querySelector('[data-testid="teammate-card-mission"]')?.textContent?.trim() ?? "",
    smallPrint: tile.querySelector('[data-testid="teammate-card-small-print"]')?.textContent?.trim() ?? "",
    slug: tile.dataset.slug ?? "",
    hasAvatar: Boolean(tile.querySelector('[data-testid="teammate-card-avatar"] svg')),
    insideBubble: Boolean(tile.closest(".bubble")),
    pills: pills ? [...pills.querySelectorAll('[data-testid="teammate-choice"]')].map((pill) => [...pill.childNodes].filter((node) => node.nodeType === 3).map((node) => node.textContent).join("").trim()) : [],
    buttonsInside: tile.querySelectorAll("button").length,
  };
})`;

async function tapPill(app: App, choice: string): Promise<void> {
  await waitFor(app, `(() => {
    const pills = [...document.querySelectorAll('[data-testid="teammate-choice"][data-choice=${json(choice)}]')];
    const pill = pills[pills.length - 1];
    if (!(pill instanceof HTMLButtonElement) || pill.disabled) return false;
    pill.click();
    return true;
  })()`, { timeoutMs: 30_000, label: `the ${choice} pill` });
}

/** Open one coworker from the rail. After a reload the app opens the first coworker by name, so the journey always says who it wants. */
async function openCoworker(app: App, slug: string, name: string, ready = true): Promise<void> {
  await waitFor(app, `(() => {
    const row = document.querySelector('[data-testid="coworker-rail-row"][data-slug=${json(slug)}]') ?? document.querySelector('[data-testid="coworker-rail-avatar"][data-slug=${json(slug)}]');
    if (!(row instanceof HTMLElement)) return false;
    row.click();
    return true;
  })()`, { timeoutMs: 120_000, label: `${name}'s rail row` });
  await waitForConversation(app, name, ready);
}

async function waitForReceipt(app: App, threadId: string, kind: "consultation" | "worker", state: string, except: string[] = []): Promise<Record<string, unknown>> {
  const receipt = await waitFor(app, `(async () => {
    const response = await window.__COWORKER__.invoke("collaboration.receipts", { slug: "nova", threadId: ${json(threadId)} });
    if (!response.ok) throw new Error(response.error);
    const receipt = response.result.find((item) => !${json(except)}.includes(item.id) && item.dependencies.some((dependency) => dependency.kind === ${json(kind)}));
    return receipt?.state === ${json(state)} ? receipt : false;
  })()`, { awaitPromise: true, timeoutMs: 120_000, label: `${kind} receipt ${state}` });
  if (!isRecord(receipt)) throw new Error("Missing collaboration receipt.");
  return receipt;
}

/** Native message ids and tool receipts are witnesses, not a route for sending work. */
async function readThreadMessages(app: App, slug: string, threadId: string): Promise<Record<string, unknown>[]> {
  const messages = await evalIn(app, `(async () => {
    const runtime = (await window.__COWORKER__.invoke("runtime.info")).result;
    const member = (await window.__COWORKER__.invoke("coworkers.get", { slug: ${json(slug)} })).result;
    const response = await fetch(runtime.serverUrl + "/workspace/" + encodeURIComponent(member.workspaceId) + "/opencode/session/" + encodeURIComponent(${json(threadId)}) + "/message", {
      headers: { Authorization: "Bearer " + runtime.ownerToken },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error("Native messages unavailable: " + response.status);
    return (await response.json()).map((message) => ({
      id: message.info.id, parentId: message.info.parentID ?? "", role: message.info.role,
      completed: typeof message.info.time?.completed === "number",
      text: message.parts.filter((part) => part.type === "text" && !part.synthetic).map((part) => part.text ?? "").join(""),
      tools: message.parts.filter((part) => part.type === "tool").map((part) => ({ name: part.tool, callId: part.callID, status: part.state.status, output: part.state.output ?? "" })),
    }));
  })()`, { awaitPromise: true, timeoutMs: 30_000 });
  if (!Array.isArray(messages) || !messages.every(isRecord)) throw new Error("Unexpected native message list.");
  return messages;
}

async function openGroup(app: App, id: string): Promise<void> {
  await waitFor(app, `(() => {
    const row = document.querySelector('[data-testid="group-rail-row"][data-group-id=${json(id)}]') ?? document.querySelector('[data-testid="group-rail-avatar"][data-group-id=${json(id)}]');
    if (!(row instanceof HTMLElement)) return false;
    row.click();
    return true;
  })()`, { timeoutMs: 30_000, label: "the consultation's visible group" });
  await waitFor(app, `document.querySelector('[data-testid="group-chat"]')?.dataset.groupId === ${json(id)}`, { label: "the selected group" });
}

async function openDiscussion(app: App, threadId: string): Promise<void> {
  await evalIn(app, `document.querySelector('[data-testid="coworker-discussion-switcher"]').click(); true`);
  await waitFor(app, `(() => {
    const choice = document.querySelector('[data-testid="coworker-discussion-menu"] [data-thread-id=${json(threadId)}]');
    if (!(choice instanceof HTMLButtonElement)) return false;
    choice.click();
    return true;
  })()`, { label: "the chosen private discussion" });
  await waitFor(app, `(async () => (await window.__COWORKER__.invoke("coworkers.get", { slug: "nova" })).result.conversationThreadId === ${json(threadId)})()`, { awaitPromise: true, label: "private selection saved" });
}

test.skipIf(!enabled)(title, { timeout: 1_200_000 }, async ({ evidence }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"], env: ["OPENWORK_EVAL_ELECTRON_BINARY"], commands: ["opencode"], placement: "local" });
  const scripted = await startScriptedModel();
  // Nothing found on "this Mac" and no keys from the host: the local mode step is a plain Continue.
  const emptyCodexHome = await mkdtemp(path.join(os.tmpdir(), "open-coworker-team-codex-"));
  // Keep the packaged profile outside this repository. OpenCode walks parent
  // directories for project configuration; a profile under evals/results
  // would inherit this checkout's own .opencode plugins and MCPs instead of
  // exercising a clean person's first launch.
  const profileDir = await mkdtemp(path.join(os.tmpdir(), "open-coworker-team-profile-"));
  onTestFinished(() => rm(emptyCodexHome, { recursive: true, force: true }));
  onTestFinished(() => rm(profileDir, { recursive: true, force: true }));
  const launchOptions = {
    name: "team",
    profileDir,
    env: {
      CODEX_HOME: emptyCodexHome,
      OPENAI_API_KEY: "",
      ANTHROPIC_API_KEY: "",
      OPENROUTER_API_KEY: "",
      GOOGLE_API_KEY: "",
      GOOGLE_GENERATIVE_AI_API_KEY: "",
      GEMINI_API_KEY: "",
      XAI_API_KEY: "",
      OLLAMA_HOST: "127.0.0.1:9",
      LMSTUDIO_HOST: "127.0.0.1:9",
    },
  };
  await using app = await coworker(launchOptions);

  // --- 1. Onboarding proposes a team: two intents, two coworkers to meet, one renamed, created in one step.
  await waitFor(app, `(document.body?.innerText ?? "").toLowerCase().includes("welcome to open coworker")`, { timeoutMs: 120_000, label: "Open Coworker welcome screen" });
  await evalIn(app, `document.querySelector('[data-testid="onboarding-local-choice"]').click(); true`);
  await waitFor(app, `Boolean(document.querySelector('[data-testid="local-mode"]'))`, { timeoutMs: 60_000, label: "the Use this Mac step" });
  await clickButton(app, "Continue", { timeoutMs: 120_000 });
  await waitFor(app, `document.querySelectorAll('[data-testid="onboarding-intent"]').length === 6`, { timeoutMs: 60_000, label: "the six intents" });
  expect(await evalIn(app, `document.querySelector('select[aria-label="Profession"]').options.length`)).toBe(9);
  await evalIn(app, `(() => { const select = document.querySelector('select[aria-label="Profession"]'); select.value = "marketing"; select.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`);
  await waitFor(app, `document.querySelector('[data-testid="work-pattern-outcome"]')?.textContent.includes("weekly campaign")`, { label: "profession explains its workflow" });
  expect(await evalIn(app, `[...document.querySelectorAll('[data-testid="onboarding-intent"][aria-pressed="true"]')].map((tile) => tile.dataset.intent)`)).toEqual(["research", "writing"]);
  await evalIn(app, `document.querySelector('[data-testid="onboarding-intents-continue"]').click(); true`);
  const proposed = await waitFor(app, `(() => {
    const cards = [...document.querySelectorAll('[data-testid="onboarding-team-cards"] [data-testid="teammate-card"]')];
    if (cards.length !== 2) return false;
    return {
      cards: cards.map((card) => ({
        roleId: card.dataset.roleId,
        name: card.querySelector('[data-testid="teammate-card-name"]')?.textContent?.trim().replace(/✎$/, "").trim(),
        role: card.querySelector('[data-testid="teammate-card-role"]')?.textContent?.trim(),
        mission: card.querySelector('[data-testid="teammate-card-mission"]')?.textContent?.trim(),
        avatar: Boolean(card.querySelector('[data-testid="teammate-card-avatar"] svg')),
      })),
      selects: document.querySelectorAll("select").length,
      railVisible: Boolean(document.querySelector('[data-testid="coworker-rail"]')),
    };
  })()`, { timeoutMs: 60_000, label: "the proposed team" });
  expect(proposed).toEqual({
    cards: [
      { roleId: "research", name: "Scout", role: "Research and synthesis", mission: expect.stringContaining("sourced campaign brief"), avatar: true },
      { roleId: "writing", name: "Editor", role: "Writing and content", mission: expect.stringContaining("content calendar for your review"), avatar: true },
    ],
    selects: 0,
    railVisible: false,
  });
  expect(await evalIn(app, `(() => {
    const cards = [...document.querySelectorAll('[data-testid="onboarding-team-cards"] [data-testid="teammate-card"]')];
    return cards.every((card) => card.scrollWidth <= card.clientWidth && [...card.querySelectorAll('p')].every((text) => text.scrollWidth <= text.clientWidth));
  })()`)).toBe(true);
  await screenshot(app);
  evidence.recordAssertionEvidence("Profession presets propose an editable team with concrete responsibilities", "Marketing selected research and writing, then proposed a sourced campaign brief and reviewable content calendar. Both full-width cards contained their role and mission without horizontal overflow; no coworker or schedule was created by selecting the preset.", true);
  // Rename the first coworker in place: tap the name, type, Enter.
  await evalIn(app, `document.querySelector('[data-testid="onboarding-team-cards"] [data-testid="teammate-card-name"]').click(); true`);
  await fill(app, '[data-testid="teammate-card-name-input"]', "Nova");
  await evalIn(app, `document.querySelector('[data-testid="teammate-card-name-input"]').dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); true`);
  await waitFor(app, `[...document.querySelectorAll('[data-testid="onboarding-team-cards"] [data-testid="teammate-card-name"]')].map((node) => node.textContent?.trim().replace(/✎$/, "").trim()).join("|") === "Nova|Editor"`, { timeoutMs: 30_000, label: "the renamed card" });
  await evalIn(app, `document.querySelector('[data-testid="onboarding-team-create"]').click(); true`);
  await waitFor(app, `Boolean(document.querySelector('[data-testid="coworker-rail"]'))`, { timeoutMs: 180_000, label: "the team rail after creation" });
  const team = resultList(await invokeCoworker(app, "coworkers.list", {}));
  expect(team.map((member) => [member.slug, member.name, member.roleId])).toEqual([["editor", "Editor", "writing"], ["nova", "Nova", "research"]]);
  await waitForConversation(app, "Nova");
  expect(await evalIn(app, `document.querySelector('[data-testid="coworker-discussion-empty-line"]')?.textContent?.trim()`)).toBe("What should we work through?");
  expect(await evalIn(app, `Boolean(document.querySelector('textarea[aria-label="Message Nova"]'))`)).toBe(true);
  // Each coworker's home knows the team and why it joined; the contract carries the team section.
  const novaRoster = resultText(await invokeCoworker(app, "coworkers.files.read", { slug: "nova", path: "team/roster.md" }));
  expect(novaRoster).toMatch(/^# My team/);
  expect(novaRoster).toContain("I am Nova (Research and synthesis).");
  expect(novaRoster).toContain("- Editor (`editor`) — Writing and content — I turn the campaign brief into consistent posts");
  expect(resultText(await invokeCoworker(app, "coworkers.files.read", { slug: "editor", path: "team/roster.md" }))).toContain("- Nova (`nova`) — Research and synthesis");
  const agents = resultText(await invokeCoworker(app, "coworkers.files.read", { slug: "nova", path: "AGENTS.md" }));
  expect(agents).toContain("<!-- open-coworker-contract: 10 -->");
  expect(agents).toContain("coworker_team_consult");
  expect(agents).toContain("end my turn; I never poll");
  expect(agents).toContain("## My team");
  // The shape rule is one section with an example per shape; the roster carries facts only, the rule is not said twice.
  expect(agents).toContain("### Which shape an answer takes");
  expect(agents).toContain("**Work on a clock.**");
  expect(agents).toContain("**A goal that outlives one reply.**");
  expect(novaRoster).not.toContain("coworker_team_refer");
  expect(resultText(await invokeCoworker(app, "coworkers.files.read", { slug: "nova", path: "memory/working.md" }))).toMatch(/- Joined the team on [A-Z][a-z]{2} \d{1,2} to help with research and writing\./);
  expect(JSON.parse(resultText(await invokeCoworker(app, "coworkers.files.read", { slug: "nova", path: "opencode.json" }))).instructions).toContain("team/roster.md");
  evidence.recordAssertionEvidence(
    "Onboarding proposes a team from what the person picks and creates it in one step",
    "After Use this Mac, the six intents appeared with Continue disabled until one was picked; research and writing proposed Scout and Editor as live cards with no select on screen; Scout was renamed Nova in place; Create my team made both coworkers, opened Nova's empty conversation with its composer, wrote each one's team description naming the other (facts only, no repeated rule), a contract at version 8 with the team section and the one shape rule with an example per shape, and a first memory line saying when it joined and what for.",
    true,
  );

  // Both coworkers answer with the scripted model; the change is applied per workspace and read back after a reload.
  const runtime = resultRecord(await invokeCoworker(app, "runtime.info", {}));
  for (const member of team) {
    const workspaceId = String(member.workspaceId);
    expect(workspaceId).not.toBe("");
    const providerPatch = await fetch(`${String(runtime.serverUrl)}/workspace/${encodeURIComponent(workspaceId)}/config`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${String(runtime.ownerToken)}` },
      body: JSON.stringify({
        opencode: {
          provider: {
            [SCRIPTED_PROVIDER]: {
              npm: "@ai-sdk/openai-compatible",
              name: "Scripted model",
              options: { baseURL: scripted.baseUrl, apiKey: "eval-scripted-key" },
              models: { [SCRIPTED_MODEL]: { name: "Scripted model", tool_call: true, variants: { low: { reasoningEffort: "low" }, medium: { reasoningEffort: "medium" }, high: { reasoningEffort: "high" } } } },
            },
          },
        },
      }),
    });
    expect(providerPatch.status).toBe(200);
    // Providers are engine-global; the engine still has to be rebuilt to read them. Wait until this
    // workspace's engine lists the scripted provider as connected before anything talks to it.
    const engineReload = await fetch(`${String(runtime.serverUrl)}/workspace/${encodeURIComponent(workspaceId)}/engine/reload`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${String(runtime.ownerToken)}` },
      body: JSON.stringify({ force: true }),
    });
    expect(engineReload.status).toBe(200);
    const deadline = Date.now() + 180_000;
    let connected = false;
    while (Date.now() < deadline) {
      const providers = await fetch(`${String(runtime.serverUrl)}/workspace/${encodeURIComponent(workspaceId)}/opencode/provider`, {
        headers: { Authorization: `Bearer ${String(runtime.ownerToken)}` },
      }).catch(() => null);
      if (providers?.ok) {
        const payload: unknown = await providers.json().catch(() => null);
        if (isRecord(payload) && Array.isArray(payload.connected) && payload.connected.includes(SCRIPTED_PROVIDER)) {
          connected = true;
          break;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    expect(connected, `${String(member.slug)}'s engine lists the scripted provider as connected`).toBe(true);
  }
  const scriptedId = `${SCRIPTED_PROVIDER}/${SCRIPTED_MODEL}`;
  // Nova has an exact thinking effort fixed ("high"), which wins every turn; Editor leaves the effort dial at Balanced, so
  // each of its turns gets the effort the dial derives from the message: a draft is deep work (high), a one-line question is quick (low).
  for (let attempt = 0; attempt < 3; attempt += 1) {
    for (const member of team) await invokeCoworker(app, "coworkers.update", { slug: String(member.slug), patch: { model: scriptedId, modelVariant: member.slug === "nova" ? "high" : "" } });
    await evalIn(app, "location.reload(); true");
    await openCoworker(app, "nova", "Nova");
    const models = resultList(await invokeCoworker(app, "coworkers.list", {})).map((member) => member.model);
    if (models.every((model) => model === scriptedId)) break;
  }
  expect(resultList(await invokeCoworker(app, "coworkers.list", {})).map((member) => member.model)).toEqual([scriptedId, scriptedId]);
  await waitForTools(app, "nova");
  await waitForTools(app, "editor");

  // --- 2. A request that is Editor's job: Nova offers to pass it on, and Ask Editor hands it over with a brief.
  const offered = await converse(app, "Nova", DRAFT_PROMPT, DRAFT_REPLY);
  expect(offered.summary).toBe("Team collaboration: Completed");
  expect(offered.text).not.toMatch(/coworker_|team_refer|ref_|\{/);
  const referralTiles = await waitFor(app, `(() => { const tiles = ${READ_TILES}; return tiles.length === 1 && tiles[0].state === "open" ? tiles : false; })()`, { timeoutMs: 30_000, label: "the hand-over tile" });
  expect(referralTiles).toEqual([{
    kind: "referral",
    state: "open",
    name: "Editor",
    role: "Writing and content",
    mission: expect.stringMatching(/^I turn the campaign brief/),
    smallPrint: "Editor could take this · Writing and content",
    slug: "editor",
    hasAvatar: true,
    insideBubble: false,
    pills: ["Ask Editor", "Continue with Nova"],
    buttonsInside: 0,
  }]);
  // What Nova's first turn received: the contract (the shape rule included) reaches the model through the
  // instruction files; the size of the system prompt and the tools offered are recorded as measured.
  const firstTurn = scripted.facts.find((facts) => facts.prompt.includes(DRAFT_PROMPT));
  expect(firstTurn).toBeDefined();
  expect(firstTurn?.contractInPrompt).toBe(true);
  expect(firstTurn?.tools ?? 0).toBeGreaterThanOrEqual(23);
  expect(firstTurn?.reasoningEffort).toBe("high");
  expect(scripted.facts.filter((facts) => facts.prompt.includes(DRAFT_PROMPT)).every((facts) => facts.reasoningEffort === "high")).toBe(true);
  evidence.recordAssertionEvidence(
    "A coworker's first turn receives the contract once, with the shape rule, beside its tools, at the thinking effort the person chose",
    `Nova's first request carried a system prompt of ${firstTurn?.systemChars ?? 0} characters that included the contract's "Which shape an answer takes" section, offered ${firstTurn?.tools ?? 0} tools, measured ${firstTurn?.bodyChars ?? 0} characters as a whole, and asked the provider for the person's exact thinking effort (reasoning_effort high, fixed in settings, so the dial stays out of it); the tool server's own one-line instruction ${firstTurn?.toolServerLineInPrompt ? "was" : "was not"} part of the prompt on this engine.`,
    true,
  );
  await tapPill(app, "ask");
  await waitForConversation(app, "Editor");
  const passed = await waitFor(app, `(() => {
    const line = document.querySelector('[data-testid="coworker-passed-from"]');
    const bubble = line?.parentElement?.querySelector(".bubble-user");
    if (!(line instanceof HTMLElement) || !(bubble instanceof HTMLElement)) return false;
    return { line: line.textContent?.trim(), bubble: bubble.textContent?.trim(), briefShown: (document.body.innerText ?? "").includes("Take it from here") };
  })()`, { timeoutMs: 60_000, label: "the passed request in Editor's conversation" });
  expect(passed).toEqual({ line: "Passed from Nova", bubble: DRAFT_PROMPT, briefShown: false });
  await waitFor(app, `[...document.querySelectorAll('[data-message-role="assistant"]')].some((message) => (message.textContent ?? "").includes(${json(EDITOR_REPLY)}))`, { timeoutMs: 300_000, label: "Editor's reply to the passed request" });
  const editorPrompt = scripted.prompts.find((prompt) => prompt.includes("Passed from Nova"));
  expect(editorPrompt).toBeDefined();
  // Editor, on the dial at Balanced: the passed request is a draft — deep work — so the provider is asked for high.
  expect(scripted.facts.find((facts) => facts.prompt.includes("Passed from Nova"))?.reasoningEffort).toBe("high");
  expect(editorPrompt).toContain(`${DRAFT_PROMPT}\n\nPassed from Nova (Research and synthesis): Editor writes for a living.`);
  expect(editorPrompt).toContain("Take it from here as your own request; the person is now talking to you.");
  await openCoworker(app, "nova", "Nova");
  const afterAsk = await waitFor(app, `(() => { const tiles = ${READ_TILES}; return tiles.length === 1 && tiles[0].state === "asked" ? tiles[0] : false; })()`, { timeoutMs: 30_000, label: "the hand-over tile settled" });
  expect(afterAsk).toMatchObject({ kind: "referral", state: "asked", smallPrint: "Passed to Editor", pills: [] });
  evidence.recordAssertionEvidence(
    "A coworker offers to pass a teammate's job on, and one tap hands it over with a brief the person never sees as scaffolding",
    "Nova answered the draft request with one sentence and a tile for Editor (avatar, name, role, mission, small print) under it — not inside the bubble, no buttons inside, two pills with no letters printed. Ask Editor switched to Editor, whose conversation showed the person's own words as their bubble under a small Passed from Nova line while the model received the request, who passed it and why, and a closing line; Editor replied. Back in Nova's conversation the tile read Passed to Editor with no pills.",
    true,
  );

  // --- 2b. A request the person keeps with Nova is never offered again: the same request comes back as a check, not a tile.
  const proofread = await converse(app, "Nova", PROOFREAD_PROMPT, PROOFREAD_REPLY);
  expect(proofread.summary).toBe("Team collaboration: Completed");
  await waitFor(app, `(() => { const tiles = ${READ_TILES}; return tiles.length === 2 && tiles[1].state === "open" && tiles[1].pills.join(",") === "Ask Editor,Continue with Nova"; })()`, { timeoutMs: 30_000, label: "the second hand-over tile" });
  await tapPill(app, "continue");
  await waitFor(app, `[...document.querySelectorAll('[data-message-role="assistant"]')].some((message) => (message.textContent ?? "").includes(${json(KEPT_REPLY)}))`, { timeoutMs: 300_000, label: "Nova taking the request back" });
  await waitFor(app, `(() => { const tiles = ${READ_TILES}; return tiles.length === 2 && tiles[1].state === "continued" && tiles[1].pills.length === 0; })()`, { timeoutMs: 30_000, label: "the kept tile settled" });
  const keptAgain = await converse(app, "Nova", PROOFREAD_AGAIN_PROMPT, PROOFREAD_AGAIN_REPLY);
  expect(keptAgain.summary).toBe("Team collaboration: Completed");
  expect(await evalIn(app, `${READ_TILES}.length`)).toBe(2);
  evidence.recordAssertionEvidence(
    "A request the person chose to keep with the coworker is never offered to a teammate again",
    "Asked to proofread the pricing page, Nova offered it to Editor; Continue with Nova sent Nova the person's Go ahead and settled the tile as kept. The same request a second time read Checked the team · you asked to keep this here between the bubbles and left no new tile — the team tool answered the model in one sentence instead of recording another offer.",
    true,
  );

  // --- 3. Work nobody covers: Nova proposes a teammate; Add to team creates it without leaving; Say hi opens it.
  await evalIn(app, `document.querySelector('button[title="New coworker"], button[aria-label="New coworker"]').click(); true`);
  await waitFor(app, `Boolean(document.querySelector('[data-testid="new-coworker-suggested"]'))`, { label: "readable suggested roles" });
  await evalIn(app, `(() => { const select = document.querySelector('select[aria-label="Profession"]'); select.value = "support"; select.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`);
  await waitFor(app, `document.querySelector('[data-testid="teammate-pick"]')?.getAttribute("data-role-id") === "support"`, { label: "support profession leads with the missing support role" });
  expect(await evalIn(app, `(() => {
    const cards = [...document.querySelectorAll('[data-testid="new-coworker-suggested"] [data-testid="teammate-card"]')];
    return cards.length === 3 && cards.every((card) => card.getBoundingClientRect().width >= 300 && card.scrollWidth <= card.clientWidth && [...card.querySelectorAll('p')].every((text) => text.scrollWidth <= text.clientWidth));
  })()`)).toBe(true);
  await screenshot(app);
  await evalIn(app, `document.querySelector('[data-testid="coworker-team-advice"] summary').click(); true`);
  await evalIn(app, `(() => { const select = document.querySelector('select[aria-label="Ask coworker"]'); select.value = "nova"; select.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`);
  await fill(app, 'textarea[aria-label="Your work and goals"]', INBOX_PROMPT);
  expect(resultList(await invokeCoworker(app, "coworkers.list", {}))).toHaveLength(2);
  await evalIn(app, `document.querySelector('[data-testid="coworker-team-advice-send"]').click(); true`);
  await waitForConversation(app, "Nova");
  const inbox = await converse(app, "Nova", INBOX_PROMPT, INBOX_REPLY, true);
  expect(scripted.prompts.some((prompt) => prompt.includes(INBOX_PROMPT) && prompt.includes("Customer success & support") && prompt.includes("Prefer existing teammates"))).toBe(true);
  expect(resultList(await invokeCoworker(app, "coworkers.list", {}))).toHaveLength(2);
  evidence.recordAssertionEvidence("The Add screen recommends roles for a profession and asks an existing coworker for AI advice", "The suggested roles were readable full-width rows. Customer success prioritized the missing support role. Asking Nova with the work description used the existing conversation and model, sent the profession and review boundaries, and returned a real teammate suggestion without creating anyone before Add to team.", true);
  expect(inbox.summary).toBe("Team collaboration: Completed");
  const suggestionTiles = await waitFor(app, `(() => { const tiles = ${READ_TILES}; return tiles.length === 3 && tiles[2].state === "open" ? tiles[2] : false; })()`, { timeoutMs: 30_000, label: "the suggested teammate tile" });
  expect(suggestionTiles).toEqual({
    kind: "suggestion",
    state: "open",
    name: "Care",
    role: "Customer support",
    mission: "I watch the inbox and answer with care.",
    smallPrint: "Suggested by Nova · Customer support",
    slug: "",
    hasAvatar: true,
    insideBubble: false,
    pills: ["Add to team", "Not now"],
    buttonsInside: 0,
  });
  const railBefore = await evalIn(app, `document.querySelectorAll('[data-testid="coworker-rail-row"]').length`);
  await tapPill(app, "add");
  const added = await waitFor(app, `(() => {
    const tiles = ${READ_TILES};
    const tile = tiles.find((candidate) => candidate.kind === "suggestion");
    if (!tile || tile.state !== "added") return false;
    const rail = document.querySelector('[data-testid="coworker-rail-row"][data-slug="care"]');
    if (!rail) return false;
    return { tile, stillNova: [...document.querySelectorAll("h1")].some((heading) => heading.textContent?.trim() === "Nova"), rows: document.querySelectorAll('[data-testid="coworker-rail-row"]').length };
  })()`, { timeoutMs: 180_000, label: "Care added to the team" });
  expect(added).toMatchObject({ tile: { state: "added", slug: "care", smallPrint: expect.stringMatching(/^Added to your team · /), pills: ["Say hi"] }, stillNova: true, rows: Number(railBefore) + 1 });
  const care = resultRecord(await invokeCoworker(app, "coworkers.get", { slug: "care" }));
  expect(care).toMatchObject({ name: "Care", role: "Customer support", roleId: "support", suggestedBy: { slug: "nova", why: "the support inbox comes up every morning" }, model: scriptedId, avatarColor: "rose" });
  expect(resultText(await invokeCoworker(app, "coworkers.files.read", { slug: "care", path: "memory/working.md" }))).toMatch(/- Joined the team on [A-Z][a-z]{2} \d{1,2}; Nova suggested me because the support inbox comes up every morning\./);
  expect(resultText(await invokeCoworker(app, "coworkers.files.read", { slug: "nova", path: "team/roster.md" }))).toContain("- Care (`care`) — Customer support — I watch the inbox and answer with care.");
  await tapPill(app, "say-hi");
  await waitForConversation(app, "Care");
  expect(await evalIn(app, `document.querySelector('[data-testid="coworker-discussion-empty-line"]')?.textContent?.trim()`)).toBe("Nova suggested me — the support inbox comes up every morning.");
  evidence.recordAssertionEvidence(
    "A coworker proposes a teammate as a contact-style tile, and one tap adds it to the team",
    "Asked to watch the support inbox every morning, Nova proposed Care with one sentence and a tile: avatar, Care, Customer support, the mission, Suggested by Nova small print, Add to team and Not now under it. Add to team created Care on Nova's model without leaving Nova's conversation, the rail gained a row, the tile flipped to Added to your team with one Say hi pill, Nova's team description named Care, Care's record remembered who proposed it and why, and Say hi opened Care's empty conversation with the line Nova suggested me — the support inbox comes up every morning.",
    true,
  );

  // --- 4. The guards leave no tile behind: a role a teammate covers, and a role the person declined.
  await openCoworker(app, "nova", "Nova");
  const covered = await converse(app, "Nova", WRITER_PROMPT, WRITER_REPLY);
  expect(covered.summary).toBe("Team collaboration: Completed");
  expect(await evalIn(app, `${READ_TILES}.length`)).toBe(3);
  await openCoworker(app, "editor", "Editor");
  const sales = await converse(app, "Editor", SALES_PROMPT, SALES_REPLY);
  expect(sales.summary).toBe("Team collaboration: Completed");
  // A one-line question is a quick reply: the dial at Balanced asks the provider for low, never the dial's own value.
  expect(scripted.facts.find((facts) => facts.prompt.includes(SALES_PROMPT))?.reasoningEffort).toBe("low");
  const salesTile = await waitFor(app, `(() => { const tiles = ${READ_TILES}; const tile = tiles.find((candidate) => candidate.kind === "suggestion"); return tile && tile.state === "open" ? tile : false; })()`, { timeoutMs: 30_000, label: "the sales suggestion" });
  expect(salesTile).toMatchObject({ name: "Pipeline", role: "Sales and relationships", smallPrint: "Suggested by Editor · Sales and relationships", pills: ["Add to team", "Not now"] });
  await tapPill(app, "dismiss");
  const declined = await waitFor(app, `(() => { const tiles = ${READ_TILES}; const tile = tiles.find((candidate) => candidate.kind === "suggestion"); return tile && tile.state === "declined" ? tile : false; })()`, { timeoutMs: 30_000, label: "the declined suggestion" });
  expect(declined).toMatchObject({ state: "declined", smallPrint: expect.stringMatching(/^Not now · /), pills: [] });
  expect(resultText(await invokeCoworker(app, "coworkers.files.read", { slug: "editor", path: "team/roster.md" }))).toMatch(/## Recently declined[\s\S]*- a sales and relationships coworker — [A-Z][a-z]{2} \d{1,2}/);
  const again = await converse(app, "Editor", SALES_AGAIN_PROMPT, SALES_AGAIN_REPLY);
  expect(again.summary).toBe("Team collaboration: Completed");
  expect(await evalIn(app, `${READ_TILES}.filter((tile) => tile.kind === "suggestion").length`)).toBe(1);
  expect(resultList(await invokeCoworker(app, "coworkers.list", {})).map((member) => member.slug)).toEqual(["care", "editor", "nova"]);
  evidence.recordAssertionEvidence(
    "A teammate who already covers a role, or a role the person declined, never becomes another tile",
    "Asked to add a writing coworker, Nova's turn read Checked the team · Editor already covers this and left no tile. Editor proposed Pipeline for the sales leads; Not now settled the tile as a record, Editor's team description listed the decline, and asking again read Checked the team · you said not now to this one with no new tile. The team is still Care, Editor, and Nova.",
    true,
  );

  // --- 5. A reload keeps every tile in the state the person left it.
  await evalIn(app, "location.reload(); true");
  await openCoworker(app, "editor", "Editor");
  const editorAfterReload = await waitFor(app, `(() => { const tiles = ${READ_TILES}; return tiles.length === 1 ? tiles[0] : false; })()`, { timeoutMs: 60_000, label: "Editor's tile after a reload" });
  expect(editorAfterReload).toMatchObject({ kind: "suggestion", state: "declined", name: "Pipeline", pills: [] });
  await openCoworker(app, "nova", "Nova");
  const novaAfterReload = await waitFor(app, `(() => { const tiles = ${READ_TILES}; return tiles.length === 3 ? tiles.map((tile) => [tile.kind, tile.state, tile.pills.join(",")]) : false; })()`, { timeoutMs: 60_000, label: "Nova's tiles after a reload" });
  expect(novaAfterReload).toEqual([["referral", "asked", ""], ["referral", "continued", ""], ["suggestion", "added", "Say hi"]]);
  evidence.recordAssertionEvidence(
    "Tiles and their states survive a reload",
    "After a reload Editor's conversation still showed the declined Pipeline tile with no pills, and Nova's showed the first hand-over as Passed to Editor, the second as kept with Nova, and the Care suggestion as added with its Say hi pill.",
    true,
  );
  await evalIn(app, `document.querySelector('button[title="New coworker"], button[aria-label="New coworker"]').click(); true`);
  await clickButton(app, "Start from scratch");
  await waitFor(app, `Boolean(document.querySelector('[data-testid="new-coworker-step-identity"]'))`, { label: "custom coworker form" });
  await fill(app, 'input[placeholder="Scout"]', "Willow");
  await evalIn(app, `document.querySelector('button[aria-label="Sand"]').click(); true`);
  await clickButton(app, "Oval");
  expect(await evalIn(app, `document.querySelectorAll('.avatar-stage .coworker-avatar__glasses ellipse').length`)).toBe(2);
  await waitFor(app, `document.querySelector('[data-testid="new-coworker-step-identity"]') && !document.querySelector('[data-testid="new-coworker-suggested"]') && [...document.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Add coworker" && button.getBoundingClientRect().bottom <= innerHeight)`, { label: "custom form separates recommendations and keeps its create button visible" });
  await screenshot(app);
  await clickButton(app, "Add coworker");
  await waitForConversation(app, "Willow");
  const willow = resultList(await invokeCoworker(app, "coworkers.list", {})).find((member) => member.slug === "willow");
  expect(willow).toMatchObject({ avatarColor: "sand", avatarGlasses: "oval" });
  await evalIn(app, "location.reload(); true");
  await waitFor(app, `Boolean(document.querySelector('[data-testid="coworker-rail"]'))`, { timeoutMs: 60_000, label: "custom avatar after reload" });
  expect(resultList(await invokeCoworker(app, "coworkers.list", {})).find((member) => member.slug === "willow")).toMatchObject({ avatarColor: "sand", avatarGlasses: "oval" });
  evidence.recordAssertionEvidence("Sand and oval frames persist without changing the avatar's established shape", "The creation form preview showed two oval lenses. Creating Willow stored sand and oval, and the same look returned after reloading the app.", true);

  await evalIn(app, `document.querySelector('[data-testid="new-group-chat"]').click(); true`);
  await clickButton(app, "Create group chat");
  const groupReady = await waitFor(app, `(() => {
    if (!document.querySelector('[data-testid="group-chat-empty"]')) return false;
    const status = document.querySelector('[data-testid="coworker-top-status"]');
    return status?.textContent?.trim() === "Ready" ? { tone: status.dataset.tone, color: getComputedStyle(status).color, dots: status.querySelectorAll('span').length } : false;
  })()`, { label: "new group is ready in the same muted sage" });
  expect(groupReady).toEqual({ tone: "ready", color: "rgb(120, 148, 135)", dots: 0 });
  evidence.recordAssertionEvidence("Group availability shares the discreet Ready tone", "Creating a group from the rail opened an empty conversation with Ready in muted sage rgb(120, 148, 135), with no status dot or unsolicited message.", true);

  // --- 6. A private request consults Editor in a visible group, then returns only to its origin.
  const unrelatedGroupId = String(await evalIn(app, `document.querySelector('[data-testid="group-chat"]').dataset.groupId`));
  const groupsBefore = resultList(await invokeCoworker(app, "groups.list", {}));
  await openCoworker(app, "nova", "Nova");
  const origin = String(resultRecord(await invokeCoworker(app, "coworkers.get", { slug: "nova" })).conversationThreadId);
  expect(origin).toMatch(/^ses_/);
  await converse(app, "Nova", CONSULT_PROMPT, CONSULT_ACK);
  await expect.poll(() => scripted.held.has("consultation"), { timeout: 120_000 }).toBe(true);
  const waitingConsult = await waitForReceipt(app, origin, "consultation", "waiting");
  expect(waitingConsult).toMatchObject({ conversationId: origin, threadId: origin, dependencies: [{ kind: "consultation", state: "running" }] });
  try {
    await waitFor(app, `document.querySelector('[data-testid="collaboration-receipt"][data-work-id=${json(waitingConsult.id)}]')?.dataset.state === "waiting" && !document.querySelector('[data-testid="coworker-working"]')`, { label: "quiet waiting receipt, not endless typing" });
  } catch (error) {
    const receipts = resultList(await invokeCoworker(app, "collaboration.receipts", { slug: "nova", threadId: origin }));
    const phase = await evalIn(app, `({ working: document.querySelector('[data-testid="coworker-working"]')?.outerHTML, receipts: document.querySelector('[data-testid="collaboration-receipts"]')?.textContent })`);
    throw new Error(`${String(error)}\nCollaboration receipts: ${JSON.stringify(receipts)}\nView: ${JSON.stringify(phase)}\nFixture errors: ${JSON.stringify(scripted.errors)}`);
  }

  const consultFacts = scripted.facts.filter((facts) => facts.prompt.includes(`Question: ${CONSULT_QUESTION}`));
  expect(consultFacts).toHaveLength(1);
  expect(consultFacts[0]).toMatchObject({ privateCanary: false, prompt: expect.stringContaining(CONSULT_CONTEXT) });
  expect(consultFacts[0]?.prompt).not.toContain(CONSULT_PROMPT);
  const requestFacts = scripted.facts.find((facts) => facts.prompt === CONSULT_PROMPT);
  expect(requestFacts).toMatchObject({ privateCanary: true, toolNames: expect.arrayContaining(["coworker_team_consult", "coworker_worker_spawn"]) });
  const originMessages = await readThreadMessages(app, "nova", origin);
  const consultRequest = originMessages.find((message) => message.role === "user" && message.text === CONSULT_PROMPT);
  expect(consultRequest).toBeDefined();
  const consultTools = originMessages.filter((message) => message.parentId === consultRequest?.id).flatMap((message) => Array.isArray(message.tools) ? message.tools.filter(isRecord) : []);
  expect(consultTools).toEqual([{ name: "coworker_team_consult", callId: expect.any(String), status: "completed", output: expect.stringContaining("Requested Question for editor") }]);

  const groupsDuring = resultList(await invokeCoworker(app, "groups.list", {}));
  const pairs = groupsDuring.filter((group) => Array.isArray(group.participantSlugs) && group.participantSlugs.length === 2 && group.participantSlugs.includes("nova") && group.participantSlugs.includes("editor"));
  expect(pairs).toHaveLength(1);
  const pair = pairs[0];
  if (!pair || typeof pair.id !== "string") throw new Error("The consultation did not create its visible pair group.");
  expect(groupsDuring).toHaveLength(groupsBefore.length + 1);
  expect(waitingConsult).toMatchObject({ dependencies: [{ groupId: pair.id }] });
  await openGroup(app, pair.id);
  await waitForText(app, CONSULT_QUESTION);
  expect(await evalIn(app, `document.body.innerText.includes(${json(PRIVATE_CANARY)})`)).toBe(false);
  expect(resultList(await invokeCoworker(app, "groups.readTimeline", { id: pair.id }))).toMatchObject([{ kind: "coworker", slug: "nova", status: "consultation", text: expect.stringContaining(CONSULT_QUESTION) }]);

  await openCoworker(app, "nova", "Nova", false);
  await evalIn(app, `document.querySelector('[data-testid="coworker-discussion-switcher"]').click(); true`);
  await waitFor(app, `Boolean(document.querySelector('[data-testid="coworker-discussion-menu"] [data-testid="coworker-new-discussion"]'))`, { label: "new discussion in the open switcher" });
  await evalIn(app, `document.querySelector('[data-testid="coworker-discussion-menu"] [data-testid="coworker-new-discussion"]').click(); true`);
  try {
    await waitFor(app, `(async () => {
      const member = (await window.__COWORKER__.invoke("coworkers.get", { slug: "nova" })).result;
      return member.conversationThreadId !== ${json(origin)} && Boolean(document.querySelector('textarea[aria-label="Message Nova"]')) && document.querySelectorAll('[data-message-role]').length === 0;
    })()`, { awaitPromise: true, label: "the new empty private discussion, not the origin" });
  } catch (error) {
    const state = await evalIn(app, `(async () => ({ selected: (await window.__COWORKER__.invoke("coworkers.get", { slug: "nova" })).result.conversationThreadId, body: document.body.innerText.slice(-5000), menus: document.querySelectorAll('[data-testid="coworker-discussion-menu"]').length }))()`, { awaitPromise: true });
    throw new Error(`${String(error)}\nDiscussion switch state: ${JSON.stringify(state)}`);
  }
  await fill(app, 'textarea[aria-label="Message Nova"]', OTHER_DISCUSSION_PROMPT);
  await clickButton(app, "Send");
  await waitForText(app, OTHER_DISCUSSION_REPLY);
  await waitFor(app, `document.querySelector('[data-testid="coworker-thread-status"]')?.dataset.state === "idle"`, { label: "separate discussion settled" });
  const otherPrivate = String(resultRecord(await invokeCoworker(app, "coworkers.get", { slug: "nova" })).conversationThreadId);
  expect(otherPrivate).toMatch(/^ses_/);
  expect(otherPrivate).not.toBe(origin);
  const otherMessages = await readThreadMessages(app, "nova", otherPrivate);

  // Switch before the answer arrives: completing background work must not navigate.
  await openCoworker(app, "editor", "Editor", false);
  const editorPrivate = String(resultRecord(await invokeCoworker(app, "coworkers.get", { slug: "editor" })).conversationThreadId);
  await fill(app, 'textarea[aria-label="Message Editor"]', PRIVATE_EDITOR_PROMPT);
  await clickButton(app, "Send");
  await waitForText(app, PRIVATE_EDITOR_REPLY);
  await waitFor(app, `document.querySelector('[data-testid="coworker-thread-status"]')?.dataset.state === "idle" && !document.querySelector('[data-testid="coworker-working"]')`, { label: "Editor's private reply clears while its group consultation still runs" });
  expect(scripted.held.has("consultation")).toBe(true);
  const editorBefore = await readThreadMessages(app, "editor", editorPrivate);
  scripted.release("consultation");
  const completedConsult = await waitForReceipt(app, origin, "consultation", "succeeded");
  expect(completedConsult).toMatchObject({ id: waitingConsult.id, conversationId: origin, dependencies: [{ state: "succeeded", groupId: pair.id }] });
  expect(scripted.prompts.filter((prompt) => prompt.startsWith(FOLLOW_UP) && prompt.includes(CONSULT_OBJECTIVE))).toEqual([expect.stringContaining(CONSULT_ANSWER)]);
  expect(await evalIn(app, `Boolean(document.querySelector('textarea[aria-label="Message Editor"]')) && !document.querySelector('[data-testid="group-chat"]')`)).toBe(true);
  expect(resultRecord(await invokeCoworker(app, "coworkers.get", { slug: "editor" })).conversationThreadId).toBe(editorPrivate);
  expect(await readThreadMessages(app, "editor", editorPrivate)).toEqual(editorBefore);
  expect(resultRecord(await invokeCoworker(app, "coworkers.get", { slug: "nova" })).conversationThreadId).toBe(otherPrivate);
  expect(await readThreadMessages(app, "nova", otherPrivate)).toEqual(otherMessages);
  const consultationTimeline = resultList(await invokeCoworker(app, "groups.readTimeline", { id: pair.id }));
  expect(consultationTimeline).toHaveLength(2);
  const answer = consultationTimeline.find((event) => event.slug === "editor");
  expect(answer).toMatchObject({ kind: "coworker", status: "succeeded", text: CONSULT_ANSWER });
  if (!answer || typeof answer.threadId !== "string") throw new Error("The group answer has no native thread.");
  expect(answer.threadId).not.toBe(editorPrivate);
  expect(await invokeCoworker(app, "collaboration.excludedThreads", { slug: "editor" })).toMatchObject({ ok: true, result: expect.arrayContaining([answer.threadId]) });
  await evalIn(app, `document.querySelector('[data-testid="coworker-discussion-switcher"]').click(); true`);
  await waitFor(app, `Boolean(document.querySelector('[data-testid="coworker-discussion-menu"]'))`, { label: "private discussion choices" });
  expect(await evalIn(app, `[...document.querySelectorAll('[data-testid="coworker-discussion-menu"] [data-thread-id]')].map((item) => item.dataset.threadId)`)).toEqual([editorPrivate]);
  await evalIn(app, `document.querySelector('[data-testid="coworker-discussion-switcher"]').click(); true`);
  await openGroup(app, pair.id);
  await waitFor(app, `[...document.querySelectorAll('[data-message-role="assistant"][data-speaker="editor"]')].filter((node) => node.textContent.includes(${json(CONSULT_ANSWER)})).length === 1`, { label: "one signed Editor answer in the group" });
  expect(await evalIn(app, `document.body.innerText.includes(${json(CONSULT_SYNTHESIS)}) || document.body.innerText.includes(${json(PRIVATE_CANARY)})`)).toBe(false);
  expect(resultList(await invokeCoworker(app, "groups.readTimeline", { id: unrelatedGroupId }))).toEqual([]);
  await openCoworker(app, "nova", "Nova");
  await openDiscussion(app, origin);
  expect(resultRecord(await invokeCoworker(app, "coworkers.get", { slug: "nova" })).conversationThreadId).toBe(origin);
  await waitFor(app, `[...document.querySelectorAll('[data-message-role="assistant"]')].filter((node) => node.textContent.includes(${json(CONSULT_SYNTHESIS)})).length === 1`, { label: "one synthesis in Nova's original private conversation" });
  const afterConsult = await readThreadMessages(app, "nova", origin);
  expect(afterConsult.filter((message) => message.role === "assistant" && message.text === CONSULT_SYNTHESIS)).toEqual([expect.objectContaining({ completed: true, parentId: completedConsult.messageId })]);
  evidence.recordAssertionEvidence("A private consultation shares only its explicit brief, publishes one group answer and returns one synthesis to the origin", "A user send invoked the installed consultation tool with a completed native tool receipt. Editor's entire inference request omitted the private canary. The pair group contained one question and one signed answer; its native answer thread was excluded from private discussions. Nova received one automatic synthesis in the originating thread while the selected Editor private conversation and unrelated group stayed unchanged.", true);

  // --- 7. A one-turn Worker yields; its completion waits behind real foreground chat.
  await converse(app, "Nova", WORKER_PROMPT, WORKER_ACK);
  await expect.poll(() => scripted.held.has("worker"), { timeout: 120_000 }).toBe(true);
  const waitingWorker = await waitForReceipt(app, origin, "worker", "waiting");
  const workers = resultList(await invokeCoworker(app, "workers.list", { slug: "nova" }));
  expect(workers).toHaveLength(1);
  const worker = workers[0];
  if (!worker || typeof worker.id !== "string" || typeof worker.threadId !== "string") throw new Error("The installed Worker tool did not start native work.");
  expect(worker).toMatchObject({ name: WORKER_NAME, spawnedBy: "coworker", spawnedFromThreadId: origin, status: "running", lifespan: { kind: "turns", max: 1, used: 0 } });
  expect(worker.threadId).toMatch(/^ses_/);
  expect(worker.threadId).not.toBe(origin);
  expect(resultRecord(await invokeCoworker(app, "turns.state", { slug: "nova", threadId: origin }))).toMatchObject({ pending: null, next: [] });
  await waitFor(app, `document.querySelector('[data-testid="collaboration-receipt"][data-work-id=${json(waitingWorker.id)}]')?.dataset.state === "waiting" && !document.querySelector('[data-testid="coworker-working"]')`, { label: "Worker wait released the private turn" });
  const workerTurn = scripted.facts.filter((facts) => facts.prompt.startsWith(`You are a Worker named "${WORKER_NAME}"`));
  expect(workerTurn).toHaveLength(1);
  expect(workerTurn[0]?.prompt).toContain('section titled "Done"');
  expect(workerTurn[0]?.toolNames).not.toContain("coworker_worker_spawn");
  expect(workerTurn[0]?.toolNames).not.toContain("coworker_team_consult");
  const spawnMessages = await readThreadMessages(app, "nova", origin);
  const spawnRequest = spawnMessages.find((message) => message.role === "user" && message.text === WORKER_PROMPT);
  expect(spawnRequest).toBeDefined();
  expect(spawnMessages.filter((message) => message.parentId === spawnRequest?.id).flatMap((message) => Array.isArray(message.tools) ? message.tools.filter(isRecord) : [])).toEqual([{ name: "coworker_worker_spawn", callId: expect.any(String), status: "completed", output: expect.stringContaining(`Requested ${WORKER_NAME}`) }]);

  await fill(app, 'textarea[aria-label="Message Nova"]', FOREGROUND_PROMPT);
  await clickButton(app, "Send");
  await expect.poll(() => scripted.held.has("foreground"), { timeout: 120_000 }).toBe(true);
  const foreground = resultRecord(await invokeCoworker(app, "turns.state", { slug: "nova", threadId: origin }));
  expect(foreground).toMatchObject({ pending: { prompt: FOREGROUND_PROMPT, stoppedAt: null }, next: [] });
  scripted.release("worker");
  const queuedWorker = await waitForReceipt(app, origin, "worker", "resumption-queued");
  expect(queuedWorker).toMatchObject({ id: waitingWorker.id, dependencies: [{ state: "succeeded" }] });
  expect(scripted.prompts.filter((prompt) => prompt.startsWith(FOLLOW_UP) && prompt.includes(WORKER_OBJECTIVE))).toEqual([]);
  expect(resultRecord(await invokeCoworker(app, "turns.state", { slug: "nova", threadId: origin }))).toEqual(foreground);
  expect(resultRecord(await invokeCoworker(app, "workers.get", { slug: "nova", id: worker.id }))).toMatchObject({ status: "finished", lifespan: { kind: "turns", max: 1, used: 1 } });
  expect(resultList(await invokeCoworker(app, "workers.findings", { slug: "nova", id: worker.id })).filter((event) => event.kind === "finding")).toEqual([expect.objectContaining({ report: "done", text: WORKER_FINDING })]);

  await openDiscussion(app, otherPrivate);
  await waitForText(app, OTHER_DISCUSSION_REPLY);
  await openCoworker(app, "editor", "Editor");
  scripted.release("foreground");
  const completedWorker = await waitForReceipt(app, origin, "worker", "succeeded");
  expect(completedWorker.id).toBe(waitingWorker.id);
  expect(scripted.prompts.filter((prompt) => prompt.startsWith(FOLLOW_UP) && prompt.includes(WORKER_OBJECTIVE))).toEqual([expect.stringContaining(WORKER_FINDING)]);
  expect(await evalIn(app, `Boolean(document.querySelector('textarea[aria-label="Message Editor"]'))`)).toBe(true);
  expect(await readThreadMessages(app, "editor", editorPrivate)).toEqual(editorBefore);
  expect(resultRecord(await invokeCoworker(app, "coworkers.get", { slug: "nova" })).conversationThreadId).toBe(otherPrivate);
  expect(await readThreadMessages(app, "nova", otherPrivate)).toEqual(otherMessages);
  await expect.poll(async () => resultList(await invokeCoworker(app, "workers.findings", { slug: "nova", id: worker.id })).filter((event) => event.kind === "review"), { timeout: 30_000 }).toEqual([expect.objectContaining({ reviewThreadId: origin })]);
  await openCoworker(app, "nova", "Nova");
  await openDiscussion(app, origin);
  await waitForText(app, WORKER_SYNTHESIS);
  const returnedMessages = await readThreadMessages(app, "nova", origin);
  expect(returnedMessages.filter((message) => message.role === "assistant" && message.text === WORKER_SYNTHESIS)).toEqual([expect.objectContaining({ completed: true, parentId: completedWorker.messageId })]);
  expect(returnedMessages.filter((message) => message.role === "assistant" && message.text === FOREGROUND_REPLY)).toHaveLength(1);
  expect(returnedMessages.findIndex((message) => message.text === FOREGROUND_REPLY)).toBeLessThan(returnedMessages.findIndex((message) => message.text === WORKER_SYNTHESIS));
  expect(resultList(await invokeCoworker(app, "groups.readTimeline", { id: pair.id }))).toEqual(consultationTimeline);
  evidence.recordAssertionEvidence("A bounded Worker yields and returns once after foreground chat without stealing navigation", "The user send invoked the installed Worker tool and started a distinct native Worker thread with one turn. Its held Done response let the parent settle and accept a foreground message. Finishing the Worker queued, but did not send, the continuation while foreground inference was held. Releasing that reply delivered one reviewed finding to the original private thread, after the foreground answer, with Editor still selected and no group mutation.", true);

  // Stop a second held child through the visible receipt; a late response,
  // renderer reload and full restart must not replay any of these tasks.
  await converse(app, "Nova", CANCEL_PROMPT, CANCEL_ACK);
  await expect.poll(() => scripted.held.has("cancelled-worker"), { timeout: 120_000 }).toBe(true);
  const stopped = await waitForReceipt(app, origin, "worker", "waiting", [String(waitingWorker.id)]);
  const cancelWorker = resultList(await invokeCoworker(app, "workers.list", { slug: "nova" })).find((item) => item.name === CANCEL_NAME);
  expect(cancelWorker).toBeDefined();
  await clickButton(app, "Stop follow-up");
  await waitForReceipt(app, origin, "worker", "cancelled", [String(waitingWorker.id)]);
  await expect.poll(async () => resultRecord(await invokeCoworker(app, "workers.get", { slug: "nova", id: cancelWorker?.id })).status, { timeout: 30_000 }).toBe("cancelled");
  scripted.release("cancelled-worker", true);
  const settledMessages = await readThreadMessages(app, "nova", origin);
  await evalIn(app, "location.reload(); true");
  await openCoworker(app, "nova", "Nova");
  await waitFor(app, `document.querySelector('[data-testid="collaboration-receipt"][data-work-id=${json(stopped.id)}]')?.dataset.state === "cancelled"`, { label: "stopped follow-up survives reload" });
  expect(await readThreadMessages(app, "nova", origin)).toEqual(settledMessages);
  await app.stop();
  await using restarted = await coworker({ ...launchOptions, name: "team-restarted" });
  await openCoworker(restarted, "nova", "Nova");
  await waitForReceipt(restarted, origin, "consultation", "succeeded");
  await waitForReceipt(restarted, origin, "worker", "succeeded");
  await waitForReceipt(restarted, origin, "worker", "cancelled", [String(waitingWorker.id)]);
  await waitFor(restarted, `document.querySelector('[data-testid="collaboration-receipt"][data-work-id=${json(stopped.id)}]')?.dataset.state === "cancelled"`, { label: "stopped follow-up survives full restart" });
  // Observe several scheduler polls, not merely an immediate zero-count check.
  for (let observation = 0; observation < 5; observation += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(await readThreadMessages(restarted, "nova", origin)).toEqual(settledMessages);
    expect(resultList(await invokeCoworker(restarted, "groups.readTimeline", { id: pair.id }))).toEqual(consultationTimeline);
    expect(scripted.prompts.filter((prompt) => prompt.startsWith(FOLLOW_UP) && prompt.includes(CANCEL_OBJECTIVE))).toEqual([]);
    expect(scripted.prompts.filter((prompt) => prompt.startsWith(FOLLOW_UP) && prompt.includes(CONSULT_OBJECTIVE))).toHaveLength(1);
    expect(scripted.prompts.filter((prompt) => prompt.startsWith(FOLLOW_UP) && prompt.includes(WORKER_OBJECTIVE))).toHaveLength(1);
  }
  expect(await evalIn(restarted, `[...document.querySelectorAll('[data-message-role="assistant"]')].filter((node) => node.textContent.includes(${json(WORKER_SYNTHESIS)})).length`)).toBe(1);
  expect(await evalIn(restarted, `document.body.innerText.includes(${json(CANCEL_SYNTHESIS)}) || document.body.innerText.includes(${json(CANCEL_FINDING)})`)).toBe(false);
  expect(resultList(await invokeCoworker(restarted, "workers.list", { slug: "nova" }))).toHaveLength(2);
  expect(resultRecord(await invokeCoworker(restarted, "workers.get", { slug: "nova", id: cancelWorker?.id })).status).toBe("cancelled");
  expect(await readThreadMessages(restarted, "nova", otherPrivate)).toEqual(otherMessages);
  expect(await readThreadMessages(restarted, "editor", editorPrivate)).toEqual(editorBefore);
  expect(scripted.errors).toEqual([]);
  expect(scripted.held.size).toBe(0);
  evidence.recordAssertionEvidence("Stopping a held Worker prevents its late return and restart does not duplicate settled collaboration", "Stop follow-up cancelled the second Worker through the visible receipt. Releasing its late provider response, reloading the renderer, and relaunching the packaged app on the same temporary profile kept the cancellation. Across five seconds of scheduler polling, native private messages and the pair timeline stayed identical, both completed automatic follow-ups still numbered one, other private threads stayed unchanged, and no cancelled follow-up was requested.", true);

  // --- 8. Real tool-side-effect canary: Continue is a new native message, not a replay.
  const liveRuntime = resultRecord(await invokeCoworker(restarted, "runtime.info", {}));
  for (const member of team) {
    const base = `${String(liveRuntime.serverUrl)}/workspace/${encodeURIComponent(String(member.workspaceId))}`;
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${String(liveRuntime.ownerToken)}` };
    // Tool permissions belong to the workspace file. The server's runtime
    // provider/MCP patch intentionally does not accept arbitrary tool grants.
    const config: unknown = JSON.parse(resultText(await invokeCoworker(restarted, "coworkers.files.read", { slug: String(member.slug), path: "opencode.json" })));
    if (!isRecord(config)) throw new Error("Expected the fixture workspace configuration.");
    await invokeCoworker(restarted, "coworkers.files.write", { slug: String(member.slug), path: "opencode.json", content: JSON.stringify({ ...config, permission: { ...(isRecord(config.permission) ? config.permission : {}), bash: member.slug === "editor" ? "ask" : "allow", question: "allow" } }) });
    expect((await fetch(`${base}/engine/reload`, { method: "POST", headers, body: JSON.stringify({ force: true }) })).status).toBe(200);
  }
  await evalIn(restarted, "location.reload(); true");
  await openCoworker(restarted, "nova", "Nova");
  await openDiscussion(restarted, origin);
  await fill(restarted, 'textarea[aria-label="Message Nova"]', CANARY_PROMPT);
  await clickButton(restarted, "Send");
  await waitFor(restarted, `document.querySelector('[data-testid="coworker-turn-failed"] [data-choice="continue"]')?.textContent.includes("Continue")`, { timeoutMs: 120_000, label: "tool-bearing failure offers Continue" });
  const failedHistory = await readThreadMessages(restarted, "nova", origin);
  const failedUser = failedHistory.find((message) => message.role === "user" && message.text === CANARY_PROMPT);
  expect(failedUser).toBeDefined();
  expect(resultText(await invokeCoworker(restarted, "coworkers.files.read", { slug: "nova", path: "continuation-canary.md" }))).toBe("counted\n");
  const failedTools = failedHistory.filter((message) => message.parentId === failedUser?.id).flatMap((message) => Array.isArray(message.tools) ? message.tools : []);
  expect(failedTools).toEqual([expect.objectContaining({ name: "bash", status: "completed" })]);
  await evalIn(restarted, `document.querySelector('[data-testid="coworker-turn-failed"] [data-choice="continue"]').click(); true`);
  await waitForText(restarted, CANARY_CONTINUED, { timeoutMs: 120_000 });
  await waitFor(restarted, `!document.querySelector('[data-testid="coworker-working"]')`, { label: "continuation settled" });
  const continuedHistory = await readThreadMessages(restarted, "nova", origin);
  expect(continuedHistory.slice(0, failedHistory.length)).toEqual(failedHistory);
  const continuedUser = continuedHistory.filter((message) => message.role === "user" && String(message.text).startsWith("Continue the earlier private request."));
  expect(continuedUser).toHaveLength(1);
  expect(continuedUser[0]?.id).not.toBe(failedUser?.id);
  expect(continuedHistory.filter((message) => message.text === CANARY_CONTINUED)).toEqual([expect.objectContaining({ parentId: continuedUser[0]?.id, completed: true })]);
  await evalIn(restarted, "location.reload(); true");
  await openCoworker(restarted, "nova", "Nova");
  expect(resultText(await invokeCoworker(restarted, "coworkers.files.read", { slug: "nova", path: "continuation-canary.md" }))).toBe("counted\n");
  expect(await readThreadMessages(restarted, "nova", origin)).toEqual(continuedHistory);
  expect(await readThreadMessages(restarted, "nova", otherPrivate)).toEqual(otherMessages);
  expect(scripted.prompts.filter((prompt) => prompt === CANARY_PROMPT)).toHaveLength(1);
  evidence.recordAssertionEvidence("Continue preserves a failed tool-bearing execution and its single real file effect", "Native bash appended one counted line, then inference failed. The visible Continue action admitted one new user message in the same native thread. All earlier user/assistant/tool records survived unchanged, the file still had exactly one line after continuation and renderer reload, and the other private discussion did not change.", true);

  // --- 9. Group native approval/question cards never answer another private session.
  await openCoworker(restarted, "editor", "Editor");
  await fill(restarted, 'textarea[aria-label="Message Editor"]', PRIVATE_QUESTION);
  await clickButton(restarted, "Send");
  const privateQuestionState = await waitFor(restarted, `document.querySelector('[data-testid="question-card"]')?.textContent.includes("PRIVATE-QUESTION-CANARY") ? "pending" : [...document.querySelectorAll('[data-message-role="assistant"]')].some((node) => node.textContent.includes("The private question was answered.")) ? "answered" : false`, { timeoutMs: 120_000, label: "private native question pending" });
  const questionConfig = privateQuestionState === "pending" ? null : await evalIn(restarted, `(async () => {
    const runtime = (await window.__COWORKER__.invoke("runtime.info")).result;
    const member = (await window.__COWORKER__.invoke("coworkers.get", {slug:"editor"})).result;
    const base = runtime.serverUrl + "/workspace/" + encodeURIComponent(member.workspaceId) + "/opencode";
    const headers = {Authorization: "Bearer " + runtime.ownerToken};
    const [config, agents, ids] = await Promise.all(["/config", "/agent", "/experimental/tool/ids"].map(route => fetch(base + route, {headers}).then(response => response.json()).catch(() => null)));
    return {defaultAgent: config?.default_agent, questionPermission: config?.permission?.question, questionTool: config?.tools?.question, agents: Array.isArray(agents) ? agents.map(agent => ({name:agent.name, questionRules:agent.permission?.filter(rule=>rule.permission==="question")})) : null, questionRegistered: Array.isArray(ids) ? ids.includes("question") : null};
  })()`, {awaitPromise:true});
  expect(privateQuestionState, JSON.stringify({ results: scripted.seenToolResults.slice(-3), config: questionConfig, tools: scripted.facts.find((fact) => fact.prompt === PRIVATE_QUESTION)?.toolNames })).toBe("pending");
  const privateWaiting = await readThreadMessages(restarted, "editor", editorPrivate);
  await openGroup(restarted, pair.id);
  await fill(restarted, '[data-testid="group-composer"]', APPROVAL_PROMPT);
  await clickButton(restarted, "Send");
  await waitFor(restarted, `Boolean(document.querySelector('[data-testid="group-waiting-person"][data-speaker="editor"] [data-testid="permission-card"]')) && !document.querySelector('[data-testid="group-working"]')`, { timeoutMs: 120_000, label: "quiet inline group permission" });
  const approvalStatus = resultRecord(await invokeCoworker(restarted, "groups.status", { id: pair.id }));
  const approval = Array.isArray(approvalStatus.interactions) ? approvalStatus.interactions.find(isRecord) : null;
  if (!isRecord(approval) || !isRecord(approval.pending) || !Array.isArray(approval.pending.permissions) || !isRecord(approval.pending.permissions[0])) throw new Error("Missing bound group approval.");
  const approvalBinding = { groupId: pair.id, executionId: approval.executionId, slug: approval.slug, threadId: approval.threadId, workspaceId: approval.workspaceId, requestId: approval.pending.permissions[0].id, kind: "permission", reply: "once" };
  expect(approval.threadId).not.toBe(editorPrivate);
  expect(await invokeCoworker(restarted, "coworkers.files.read", { slug: "editor", path: "approval-canary.md" })).toMatchObject({ ok: false });
  expect(await evalIn(restarted, `document.body.innerText.includes("PRIVATE-QUESTION-CANARY")`)).toBe(false);
  await fill(restarted, '[data-testid="group-composer"]', "Keep this draft while I decide");
  await expect.poll(() => evalIn(restarted, `document.activeElement?.getAttribute("data-testid")`)).toBe("group-composer");
  await openGroup(restarted, unrelatedGroupId);
  expect(await evalIn(restarted, `document.querySelectorAll('[data-testid="permission-card"], [data-testid="question-card"]').length`)).toBe(0);
  expect(await invokeCoworker(restarted, "groups.interactions.reply", { ...approvalBinding, groupId: unrelatedGroupId })).toMatchObject({ ok: false });
  expect(await invokeCoworker(restarted, "groups.interactions.reply", { ...approvalBinding, threadId: editorPrivate })).toMatchObject({ ok: false });
  expect(await readThreadMessages(restarted, "editor", editorPrivate)).toEqual(privateWaiting);
  await openGroup(restarted, pair.id);
  await waitFor(restarted, `(() => { const button = [...document.querySelectorAll('[data-testid="group-waiting-person"][data-speaker="editor"] [data-testid="permission-card"] button')].find((button) => button.textContent.includes("Allow once")); if (!(button instanceof HTMLButtonElement) || button.disabled) return false; button.click(); return true; })()`, { label: "approve the restored group permission card once" });
  await waitForText(restarted, APPROVAL_REPLY, { timeoutMs: 120_000 });
  await waitFor(restarted, `!document.querySelector('[data-testid="group-waiting-person"]') && document.querySelector('[data-testid="group-chat"]')?.dataset.live === "false"`, { label: "same group approval execution finished" });
  expect(resultText(await invokeCoworker(restarted, "coworkers.files.read", { slug: "editor", path: "approval-canary.md" }))).toBe("approved\n");
  const approvalMessages = await readThreadMessages(restarted, "editor", String(approval.threadId));
  expect(approvalMessages.filter((message) => message.role === "user")).toHaveLength(1);
  expect(approvalMessages.filter((message) => message.text === APPROVAL_REPLY)).toHaveLength(1);
  expect(await invokeCoworker(restarted, "groups.interactions.reply", approvalBinding)).toMatchObject({ ok: false });
  for (const { prompt, cancel } of [{ prompt: GROUP_QUESTION, cancel: false }, { prompt: GROUP_CANCEL_QUESTION, cancel: true }]) {
    await fill(restarted, '[data-testid="group-composer"]', prompt);
    await clickButton(restarted, "Send");
    await waitFor(restarted, `Boolean(document.querySelector('[data-testid="group-waiting-person"] [data-testid="question-card"]')) && !document.querySelector('[data-testid="group-working"]')`, { timeoutMs: 120_000, label: "native question inside the group" });
    const status = resultRecord(await invokeCoworker(restarted, "groups.status", { id: pair.id }));
    const wait = Array.isArray(status.interactions) ? status.interactions.find(isRecord) : null;
    if (!isRecord(wait) || !isRecord(wait.pending) || !Array.isArray(wait.pending.questions) || !isRecord(wait.pending.questions[0])) throw new Error("Missing bound group question.");
    if (cancel) await evalIn(restarted, `document.querySelector('[data-testid="group-waiting-person"] > button').click(); true`);
    else await evalIn(restarted, `[...document.querySelectorAll('[data-testid="group-waiting-person"] [data-testid="question-card"] button')].find((button) => button.textContent.includes("North")).click(); true`);
    await waitFor(restarted, `!document.querySelector('[data-testid="group-waiting-person"]') && document.querySelector('[data-testid="group-chat"]')?.dataset.live === "false"`, { timeoutMs: 120_000, label: cancel ? "group question cancellation settled" : "native question answer settled" });
    if (!cancel) await waitForText(restarted, "The group chose North.");
    expect(await invokeCoworker(restarted, "groups.interactions.reply", { groupId: pair.id, executionId: wait.executionId, workspaceId: wait.workspaceId, slug: wait.slug, threadId: wait.threadId, kind: "question", requestId: wait.pending.questions[0].id, answers: [["North"]] })).toMatchObject({ ok: false });
  }
  const groupMessages = await readThreadMessages(restarted, "editor", String(approval.threadId));
  expect(groupMessages.filter((message) => message.role === "user")).toHaveLength(3);
  expect(groupMessages.some((message) => message.text === "This cancelled question must not complete.")).toBe(false);
  expect(groupMessages.filter((message) => message.role === "assistant").flatMap((message) => Array.isArray(message.tools) ? message.tools : [])).toEqual(expect.arrayContaining([expect.objectContaining({ name: "question", status: "completed", output: expect.stringContaining("North") })]));
  expect(await readThreadMessages(restarted, "editor", editorPrivate)).toEqual(privateWaiting);
  await openCoworker(restarted, "editor", "Editor", false);
  await waitFor(restarted, `document.querySelector('[data-testid="question-card"]')?.textContent.includes("PRIVATE-QUESTION-CANARY")`, { label: "private question remains unanswered" });
  expect(await evalIn(restarted, `document.body.innerText.includes("Group direction")`)).toBe(false);
  expect(await invokeCoworker(restarted, "turns.cancel", { slug: "editor", threadId: editorPrivate })).toMatchObject({ ok: true });
  evidence.recordAssertionEvidence("Group permission and question replies stay bound to their native execution and do not expose or answer a private question", "The group showed Editor's native cards with a static waiting receipt and no writing indicator. Wrong-group and wrong-session replies were rejected, Allow once wrote one line without another native user message, North answered the next native question, and cancelling the last question rejected a late answer. The simultaneous private question remained unchanged and visible only in Editor's private discussion.", true);
});
