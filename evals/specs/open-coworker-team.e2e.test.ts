import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { clickButton, coworker, evalIn, fill, needs, test, waitFor, waitForText } from "@openwork/testkit";
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
 */

const enabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const title = enabled
  ? "Open Coworker proposes a team at onboarding, teammates know each other and hand work over, and a coworker's suggestion adds a teammate in one tap"
  : "Open Coworker team journey skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1";

const SCRIPTED_PROVIDER = "eval-scripted";
const SCRIPTED_MODEL = "scripted";

const DRAFT_PROMPT = "Draft the launch announcement";
const DRAFT_REPLY = "Editor is better suited for this — want me to pass it over?";
const EDITOR_REPLY = "On it — a first draft of the announcement is coming.";
const INBOX_PROMPT = "Can you keep an eye on the support inbox every morning?";
const INBOX_REPLY = "That's a job for a support coworker — want me to add one?";
const WRITER_PROMPT = "Add a writing coworker";
const WRITER_REPLY = "Editor already covers writing — want me to pass this to them?";
const SALES_PROMPT = "Who could handle our sales leads?";
const SALES_REPLY = "A sales coworker could own that — want me to add one?";
const SALES_AGAIN_PROMPT = "Anyone for the sales leads, then?";
const SALES_AGAIN_REPLY = "Understood, I'll leave that be for now.";

type ScriptedCall = { name: string; arguments: Record<string, unknown> };
type ScriptedTurn = { call: ScriptedCall | null; reply: string };

/** First match wins: a request passed on carries the original words too, so the hand-over line comes first. */
const SCRIPT: Array<{ match: string; turn: ScriptedTurn }> = [
  { match: "Passed from Nova", turn: { call: null, reply: EDITOR_REPLY } },
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

function streamChunks(response: ServerResponse, deltas: Array<Record<string, unknown>>, finish: string): void {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const base = { id: "chatcmpl-scripted", object: "chat.completion.chunk", created: 1, model: SCRIPTED_MODEL };
  for (const delta of deltas) response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`);
  response.write("data: [DONE]\n\n");
  response.end();
}

async function startScriptedModel(): Promise<{ baseUrl: string; seenToolResults: string[]; prompts: string[] }> {
  const state = { baseUrl: "", seenToolResults: [] as string[], prompts: [] as string[] };
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
        const scripted = SCRIPT.find((entry) => prompt.includes(entry.match));
        const results = toolResults(body);
        state.seenToolResults.push(...results);
        if (results.length === 0) state.prompts.push(prompt);
        if (scripted?.turn.call && results.length === 0) {
          const call = scripted.turn.call;
          streamChunks(response, [{
            role: "assistant",
            content: null,
            tool_calls: [{ index: 0, id: `call_${call.name}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }],
          }], "tool_calls");
          return;
        }
        streamChunks(response, [{ role: "assistant" }, { content: scripted?.turn.reply ?? "Okay." }], "stop");
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

async function waitForConversation(app: App, name: string): Promise<void> {
  await waitFor(app, `Boolean(document.querySelector('[data-testid="coworker-discussion-view"]') || document.querySelector('[data-testid="coworker-discussion-empty"]')) && [...document.querySelectorAll("h1")].some((heading) => heading.textContent?.trim() === ${json(name)})`, {
    timeoutMs: 120_000,
    label: `${name}'s conversation`,
  });
  await waitFor(app, `document.querySelector('[data-testid="coworker-top-status"]')?.textContent?.trim() === "Ready"`, { timeoutMs: 240_000, label: `${name} ready` });
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
async function converse(app: App, name: string, prompt: string, reply: string): Promise<{ summary: string; steps: string[]; text: string }> {
  await fill(app, `textarea[aria-label=${json(`Message ${name}`)}]`, prompt);
  await clickButton(app, "Send");
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
      summary: summary?.querySelector("span.truncate")?.textContent?.trim() ?? "",
      steps: [...line.querySelectorAll('[data-testid="coworker-work-step"]')].map((step) => step.querySelector("span.truncate")?.textContent?.trim() ?? ""),
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
async function openCoworker(app: App, slug: string, name: string): Promise<void> {
  await waitFor(app, `(() => {
    const row = document.querySelector('[data-testid="coworker-rail-row"][data-slug=${json(slug)}]') ?? document.querySelector('[data-testid="coworker-rail-avatar"][data-slug=${json(slug)}]');
    if (!(row instanceof HTMLElement)) return false;
    row.click();
    return true;
  })()`, { timeoutMs: 120_000, label: `${name}'s rail row` });
  await waitForConversation(app, name);
}

test.skipIf(!enabled)(title, { timeout: 1_200_000 }, async ({ evidence }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"], commands: ["opencode"] });
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
  await using app = await coworker({
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
  });

  // --- 1. Onboarding proposes a team: two intents, two coworkers to meet, one renamed, created in one step.
  await waitFor(app, `(document.body?.innerText ?? "").toLowerCase().includes("welcome to open coworker")`, { timeoutMs: 120_000, label: "Open Coworker welcome screen" });
  await evalIn(app, `document.querySelector('[data-testid="onboarding-local-choice"]').click(); true`);
  await waitFor(app, `Boolean(document.querySelector('[data-testid="local-mode"]'))`, { timeoutMs: 60_000, label: "the Use this Mac step" });
  await clickButton(app, "Continue", { timeoutMs: 120_000 });
  await waitFor(app, `document.querySelectorAll('[data-testid="onboarding-intent"]').length === 6`, { timeoutMs: 60_000, label: "the six intents" });
  await evalIn(app, `document.querySelector('[data-testid="onboarding-intent"][data-intent="research"]').click(); document.querySelector('[data-testid="onboarding-intent"][data-intent="writing"]').click(); true`);
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
      { roleId: "research", name: "Scout", role: "Research and synthesis", mission: expect.stringMatching(/^I /), avatar: true },
      { roleId: "writing", name: "Editor", role: "Writing and content", mission: expect.stringMatching(/^I /), avatar: true },
    ],
    selects: 0,
    railVisible: false,
  });
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
  expect(novaRoster).toContain("- Editor (`editor`) — Writing and content — I turn rough ideas into clear drafts");
  expect(resultText(await invokeCoworker(app, "coworkers.files.read", { slug: "editor", path: "team/roster.md" }))).toContain("- Nova (`nova`) — Research and synthesis");
  const agents = resultText(await invokeCoworker(app, "coworkers.files.read", { slug: "nova", path: "AGENTS.md" }));
  expect(agents).toContain("<!-- open-coworker-contract: 5 -->");
  expect(agents).toContain("## My team");
  expect(resultText(await invokeCoworker(app, "coworkers.files.read", { slug: "nova", path: "memory/working.md" }))).toMatch(/- Joined the team on [A-Z][a-z]{2} \d{1,2} to help with research and writing\./);
  expect(JSON.parse(resultText(await invokeCoworker(app, "coworkers.files.read", { slug: "nova", path: "opencode.json" }))).instructions).toContain("team/roster.md");
  evidence.recordAssertionEvidence(
    "Onboarding proposes a team from what the person picks and creates it in one step",
    "After Use this Mac, the six intents appeared with Continue disabled until one was picked; research and writing proposed Scout and Editor as live cards with no select on screen; Scout was renamed Nova in place; Create my team made both coworkers, opened Nova's empty conversation with its composer, wrote each one's team description naming the other, a contract at version 5 with the team section, and a first memory line saying when it joined and what for.",
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
              models: { [SCRIPTED_MODEL]: { name: "Scripted model", tool_call: true } },
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
  for (let attempt = 0; attempt < 3; attempt += 1) {
    for (const member of team) await invokeCoworker(app, "coworkers.update", { slug: String(member.slug), patch: { model: scriptedId, modelVariant: "" } });
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
  expect(offered.summary).toBe("Offered to pass this to Editor");
  expect(offered.text).not.toMatch(/coworker_|team_refer|ref_|\{/);
  const referralTiles = await waitFor(app, `(() => { const tiles = ${READ_TILES}; return tiles.length === 1 && tiles[0].state === "open" ? tiles : false; })()`, { timeoutMs: 30_000, label: "the hand-over tile" });
  expect(referralTiles).toEqual([{
    kind: "referral",
    state: "open",
    name: "Editor",
    role: "Writing and content",
    mission: expect.stringMatching(/^I turn rough ideas/),
    smallPrint: "Editor could take this · Writing and content",
    slug: "editor",
    hasAvatar: true,
    insideBubble: false,
    pills: ["Ask Editor", "Continue with Nova"],
    buttonsInside: 0,
  }]);
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

  // --- 3. Work nobody covers: Nova proposes a teammate; Add to team creates it without leaving; Say hi opens it.
  const inbox = await converse(app, "Nova", INBOX_PROMPT, INBOX_REPLY);
  expect(inbox.summary).toBe("Suggested a teammate · Care");
  const suggestionTiles = await waitFor(app, `(() => { const tiles = ${READ_TILES}; return tiles.length === 2 && tiles[1].state === "open" ? tiles[1] : false; })()`, { timeoutMs: 30_000, label: "the suggested teammate tile" });
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
  expect(covered.summary).toBe("Checked the team · Editor already covers this");
  expect(await evalIn(app, `${READ_TILES}.length`)).toBe(2);
  await openCoworker(app, "editor", "Editor");
  const sales = await converse(app, "Editor", SALES_PROMPT, SALES_REPLY);
  expect(sales.summary).toBe("Suggested a teammate · Pipeline");
  const salesTile = await waitFor(app, `(() => { const tiles = ${READ_TILES}; const tile = tiles.find((candidate) => candidate.kind === "suggestion"); return tile && tile.state === "open" ? tile : false; })()`, { timeoutMs: 30_000, label: "the sales suggestion" });
  expect(salesTile).toMatchObject({ name: "Pipeline", role: "Sales and relationships", smallPrint: "Suggested by Editor · Sales and relationships", pills: ["Add to team", "Not now"] });
  await tapPill(app, "dismiss");
  const declined = await waitFor(app, `(() => { const tiles = ${READ_TILES}; const tile = tiles.find((candidate) => candidate.kind === "suggestion"); return tile && tile.state === "declined" ? tile : false; })()`, { timeoutMs: 30_000, label: "the declined suggestion" });
  expect(declined).toMatchObject({ state: "declined", smallPrint: expect.stringMatching(/^Not now · /), pills: [] });
  expect(resultText(await invokeCoworker(app, "coworkers.files.read", { slug: "editor", path: "team/roster.md" }))).toMatch(/## Recently declined[\s\S]*- a sales and relationships coworker — [A-Z][a-z]{2} \d{1,2}/);
  const again = await converse(app, "Editor", SALES_AGAIN_PROMPT, SALES_AGAIN_REPLY);
  expect(again.summary).toBe("Checked the team · you said not now to this one");
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
  const novaAfterReload = await waitFor(app, `(() => { const tiles = ${READ_TILES}; return tiles.length === 2 ? tiles.map((tile) => [tile.kind, tile.state, tile.pills.join(",")]) : false; })()`, { timeoutMs: 60_000, label: "Nova's tiles after a reload" });
  expect(novaAfterReload).toEqual([["referral", "asked", ""], ["suggestion", "added", "Say hi"]]);
  evidence.recordAssertionEvidence(
    "Tiles and their states survive a reload",
    "After a reload Editor's conversation still showed the declined Pipeline tile with no pills, and Nova's showed the hand-over as Passed to Editor and the Care suggestion as added with its Say hi pill.",
    true,
  );
});
