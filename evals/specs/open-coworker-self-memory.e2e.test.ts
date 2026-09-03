import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { clickButton, coworker, evalIn, fill, needs, test, waitFor } from "@openwork/testkit";
import { expect, onTestFinished } from "vitest";

/**
 * A coworker keeps its memory and soul current while talking. A deterministic
 * OpenAI-compatible model plays the coworker's side: told a stable fact it
 * calls memory_remember, told how to communicate it calls soul_update, asked
 * what it knows it calls self_read. Everything else is the real product path:
 * the coworker's own tool server, the tracked atomic writes, the changes log,
 * the action lines in the conversation, and the Memory view with Undo.
 */

const enabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const title = enabled
  ? "Open Coworker remembers, changes how it works, and reads itself back from the conversation, with every change visible and undoable"
  : "Open Coworker self-memory journey skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1";

const SCRIPTED_PROVIDER = "eval-scripted";
const SCRIPTED_MODEL = "scripted";
const FACT_PROMPT = "I work in Product, by the way.";
const FACT_REPLY = "Noted — you work in Product.";
const STYLE_PROMPT = "Be shorter from now on.";
const STYLE_REPLY = "Will do. Shorter replies from here on.";
const RECALL_PROMPT = "What do you know about me?";
const RECALL_REPLY = "You work in Product. That is all I have kept so far.";

type ScriptedCall = { name: string; arguments: Record<string, unknown> };
type ScriptedTurn = { call: ScriptedCall; reply: string };

const SCRIPT: Array<{ match: string; turn: ScriptedTurn }> = [
  {
    match: "work in Product",
    turn: {
      call: { name: "coworker_memory_remember", arguments: { text: "You work in Product", kind: "long-term", topic: "About you" } },
      reply: FACT_REPLY,
    },
  },
  {
    match: "shorter",
    turn: {
      call: { name: "coworker_soul_update", arguments: { section: "Communication", change: { kind: "add", text: "Shorter replies." } } },
      reply: STYLE_REPLY,
    },
  },
  {
    match: "know about me",
    turn: { call: { name: "coworker_self_read", arguments: { what: "memory" } }, reply: RECALL_REPLY },
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

/** The tool results the engine sent back for the current turn (after the last user message), so the script knows the turn's tool half is done. */
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

async function startScriptedModel(): Promise<{ baseUrl: string; seenToolResults: string[] }> {
  const state = { baseUrl: "", seenToolResults: [] as string[] };
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
        if (scripted && results.length === 0) {
          streamChunks(response, [{
            role: "assistant",
            content: null,
            tool_calls: [{ index: 0, id: `call_${scripted.turn.call.name}`, type: "function", function: { name: scripted.turn.call.name, arguments: JSON.stringify(scripted.turn.call.arguments) } }],
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

async function invokeCoworker(app: Awaited<ReturnType<typeof coworker>>, command: string, payload: unknown): Promise<unknown> {
  return evalIn(app, `window.__COWORKER__.invoke(${json(command)}, ${json(payload)})`, { awaitPromise: true, timeoutMs: 120_000 });
}

function resultRecord(response: unknown): Record<string, unknown> {
  if (!isRecord(response) || response.ok !== true || !isRecord(response.result)) {
    throw new Error(`Open Coworker bridge returned an unexpected response: ${JSON.stringify(response)}`);
  }
  return response.result;
}

function resultText(response: unknown): string {
  const record = resultRecord(response);
  return typeof record.content === "string" ? record.content : "";
}

async function waitForNovaReady(app: Awaited<ReturnType<typeof coworker>>): Promise<void> {
  await waitFor(app, `Boolean(document.querySelector('[data-testid="coworker-discussion-view"]')) && [...document.querySelectorAll("h1")].some((heading) => heading.textContent?.trim() === "Nova")`, {
    timeoutMs: 120_000,
    label: "Nova discussion view",
  });
  await waitFor(app, `document.querySelector('[data-testid="coworker-top-status"]')?.textContent?.trim() === "Ready"`, { timeoutMs: 240_000, label: "Nova ready" });
}

/** Send one message and wait for the coworker's reply text; returns the settled action line's collapsed words. */
async function converse(app: Awaited<ReturnType<typeof coworker>>, prompt: string, reply: string): Promise<{ summary: string; steps: string[]; text: string }> {
  await fill(app, 'textarea[aria-label="Message Nova"]', prompt);
  await clickButton(app, "Send");
  await waitFor(app, `[...document.querySelectorAll('[data-message-role="assistant"]')].some((message) => (message.textContent ?? "").includes(${json(reply)}))`, {
    timeoutMs: 300_000,
    label: `reply ${json(reply)}`,
  });
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

async function openMemoryView(app: Awaited<ReturnType<typeof coworker>>): Promise<void> {
  await waitFor(app, `(() => {
    const panel = document.querySelector('[data-testid="context-panel"]');
    if (!(panel instanceof HTMLElement)) return false;
    if (panel.dataset.collapsed === "false" && panel.dataset.view === "memory") return Boolean(document.querySelector('[data-testid="memory-recent-changes"]'));
    if (panel.dataset.collapsed === "true") document.querySelector('[data-testid="context-rail-memory"]')?.click();
    else window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return false;
  })()`, { timeoutMs: 60_000, label: "Memory view" });
}

const READ_CHANGE_ROWS = `[...document.querySelectorAll('[data-testid="memory-change-row"]')].map((row) => ({
  label: row.querySelector('[data-testid="memory-change-label"]')?.textContent?.trim() ?? "",
  tool: row.dataset.tool,
  undone: row.dataset.undone,
  button: row.querySelector("button")?.textContent?.trim() ?? "",
}))`;

test.skipIf(!enabled)(title, { timeout: 900_000 }, async ({ evidence }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"], commands: ["opencode"] });
  const scripted = await startScriptedModel();
  await using app = await coworker({ name: "self-memory" });

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
  // The config route announces the change; without the desktop's reload listener the engine is reloaded here.
  const engineReload = await fetch(`${String(runtime.serverUrl)}/workspace/${encodeURIComponent(workspaceId)}/engine/reload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${String(runtime.ownerToken)}` },
  });
  expect(engineReload.status).toBe(200);
  await invokeCoworker(app, "coworkers.update", { slug: "nova", patch: { model: `${SCRIPTED_PROVIDER}/${SCRIPTED_MODEL}`, modelVariant: "" } });
  await evalIn(app, "location.reload(); true");
  await waitForNovaReady(app);

  // The coworker's home carries the current contract: the same turn, the self tools, the soul's four sections.
  const agents = resultText(await invokeCoworker(app, "coworkers.files.read", { slug: "nova", path: "AGENTS.md" }));
  expect(agents).toContain("## Keeping memory and soul current");
  expect(agents).toContain("in that same turn");
  expect(agents).toContain("coworker_memory_remember");
  expect(agents).toContain("coworker_soul_update");
  const soulBefore = resultText(await invokeCoworker(app, "coworkers.files.read", { slug: "nova", path: "soul.md" }));
  expect(soulBefore).toMatch(/## Role[\s\S]*## Mission[\s\S]*## Principles[\s\S]*## Communication/);

  // --- A stable fact about the person is remembered in the same turn, visibly.
  const remembered = await converse(app, FACT_PROMPT, FACT_REPLY);
  expect(remembered.summary).toBe("Remembered · You work in Product");
  expect(remembered.text).not.toMatch(/coworker_|memory_remember|"kind"|\{/);
  const aboutYou = resultText(await invokeCoworker(app, "coworkers.files.read", { slug: "nova", path: "memory/long-term/about-you.md" }));
  expect(aboutYou).toBe("# About you\n\n- You work in Product\n");
  expect(resultText(await invokeCoworker(app, "coworkers.files.read", { slug: "nova", path: "memory/index.md" }))).toContain("- `long-term/about-you.md` — About you");
  expect(scripted.seenToolResults.some((result) => result.includes("Remembered in long-term memory (About you): You work in Product"))).toBe(true);

  // --- A preference about communication changes the soul, inside one section only.
  const styled = await converse(app, STYLE_PROMPT, STYLE_REPLY);
  expect(styled.summary).toBe("Updated how I work · Shorter replies.");
  const soulAfter = resultText(await invokeCoworker(app, "coworkers.files.read", { slug: "nova", path: "soul.md" }));
  expect(soulAfter).toContain("- Shorter replies.");
  expect(soulAfter.split("## Communication")[0]).toBe(soulBefore.split("## Communication")[0]);
  expect(soulAfter.match(/^## /gm)?.length).toBe(4);

  // --- Asked what it knows, the coworker reads its own files rather than guessing.
  const recalled = await converse(app, RECALL_PROMPT, RECALL_REPLY);
  expect(recalled.summary).toBe("Checked what I remember");
  expect(scripted.seenToolResults.some((result) => result.includes("memory/long-term/about-you.md") && result.includes("You work in Product"))).toBe(true);
  expect(await evalIn(app, `document.querySelectorAll('[data-testid="coworker-action-line"]').length`)).toBe(3);
  expect(String(await evalIn(app, `[...document.querySelectorAll('[data-testid="coworker-work-summary"]')].map((button) => button.textContent?.trim()).join(" | ")`))).not.toMatch(/coworker_|\{/);
  evidence.recordAssertionEvidence(
    "The coworker records a fact, a way of working, and reads itself back in the same turns, each as one plain action line",
    `Three turns produced three action lines — "Remembered · You work in Product", "Updated how I work · Shorter replies.", "Checked what I remember" — with no tool ids or JSON in them. The fact landed in memory/long-term/about-you.md and the index; the soul gained one Communication bullet with its other three sections byte for byte unchanged; the self read returned the memory files to the model.`,
    true,
  );

  // --- The Memory view shows the changes at once, and Undo restores the prior text.
  await openMemoryView(app);
  const rows = await waitFor(app, `(() => {
    const rows = ${READ_CHANGE_ROWS};
    return rows.length === 2 ? rows : false;
  })()`, { timeoutMs: 30_000, label: "two recent changes" });
  expect(rows).toEqual([
    { label: "Updated how I work · Shorter replies.", tool: "soul_update", undone: "false", button: "Undo" },
    { label: "Remembered · You work in Product", tool: "memory_remember", undone: "false", button: "Undo" },
  ]);
  expect(await evalIn(app, `document.querySelector('[data-testid="memory-count"]')?.textContent?.trim()`)).toBe("1");
  await evalIn(app, `document.querySelector('[data-testid="memory-tab-soul"]').click(); true`);
  await waitFor(app, `(document.querySelector('[data-testid="memory-view"]')?.textContent ?? "").includes("Shorter replies.")`, { timeoutMs: 30_000, label: "soul page showing the new line" });
  await evalIn(app, `document.querySelector('[data-testid="memory-change-row"][data-tool="soul_update"] button').click(); true`);
  const afterUndo = await waitFor(app, `(() => {
    const rows = ${READ_CHANGE_ROWS};
    if (rows.length !== 3) return false;
    const view = document.querySelector('[data-testid="memory-view"]')?.textContent ?? "";
    if (view.includes("Shorter replies.")) return false;
    return { rows, communicationLines: (view.match(/Concise, concrete/g) ?? []).length };
  })()`, { timeoutMs: 30_000, label: "the undo recorded and the soul page restored" });
  expect(afterUndo).toEqual({
    rows: [
      { label: "Undid · Updated how I work · Shorter replies.", tool: "undo", undone: "false", button: "Undo" },
      { label: "Updated how I work · Shorter replies.", tool: "soul_update", undone: "true", button: "Undone" },
      { label: "Remembered · You work in Product", tool: "memory_remember", undone: "false", button: "Undo" },
    ],
    communicationLines: 1,
  });
  expect(resultText(await invokeCoworker(app, "coworkers.files.read", { slug: "nova", path: "soul.md" }))).toBe(soulBefore);
  const log = resultText(await invokeCoworker(app, "coworkers.files.read", { slug: "nova", path: "memory/changes.jsonl" }));
  const entries = log.trim().split("\n").map((line) => JSON.parse(line));
  expect(entries.map((entry) => [entry.actor, entry.tool])).toEqual([["coworker", "memory_remember"], ["coworker", "soul_update"], ["undo", "undo"]]);
  expect(entries[2].undoes).toBe(entries[1].id);
  expect(entries[1].files[0].before).not.toContain("Shorter replies.");
  expect(entries[1].files[0].after).toContain("Shorter replies.");

  // --- A reload keeps everything: the changes, the undone state, the restored soul, the memory.
  await evalIn(app, "location.reload(); true");
  await waitForNovaReady(app);
  await openMemoryView(app);
  const afterReload = await waitFor(app, `(() => {
    const rows = ${READ_CHANGE_ROWS};
    return rows.length === 3 ? rows.map((row) => [row.tool, row.undone]) : false;
  })()`, { timeoutMs: 30_000, label: "recent changes after a reload" });
  expect(afterReload).toEqual([["undo", "false"], ["soul_update", "true"], ["memory_remember", "false"]]);
  await evalIn(app, `document.querySelector('[data-testid="memory-tab-long-term"]').click(); true`);
  const memoryRows = await waitFor(app, `(() => {
    const rows = [...document.querySelectorAll('[data-testid="memory-row"]')];
    return rows.length === 1 ? rows.map((row) => row.querySelector("span")?.textContent?.trim()) : false;
  })()`, { timeoutMs: 30_000, label: "the About you memory after a reload" });
  expect(memoryRows).toEqual(["About you"]);
  expect(resultText(await invokeCoworker(app, "coworkers.files.read", { slug: "nova", path: "soul.md" }))).toBe(soulBefore);
  evidence.recordAssertionEvidence(
    "Every change to memory and soul is listed in the Memory view and can be undone, and all of it survives a reload",
    "Recent changes listed the soul change and the remembered fact newest first with Undo on each; Undo on the soul change restored the soul byte for byte, marked that row Undone, and added an \"Undid · …\" row, all recorded in memory/changes.jsonl with the prior and new text. After a reload the three rows, the undone state, the restored soul, and the About you memory were all still there.",
    true,
  );
});
