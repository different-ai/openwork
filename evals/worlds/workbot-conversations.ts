import { createServer, type RequestListener, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { chrome } from "@openwork/hosts";
import type { Place, Seed } from "@openwork/env";
import { bootWorkbot, signInWorkbot } from "../../worlds/lib/workbot.ts";

/**
 * Real Workbot, runner, OAuth and Den, with a model that holds requests to Anthropic's rules: a tool result must
 * answer a tool call in the message right before it, and a conversation starts with the person. The runner's
 * context is small (12,000 characters), so a short journey outgrows what the model can see.
 */

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
const text = (value: string): Block => ({ type: "text", text: value });
const tool = (name: string, input: Record<string, unknown>): Block => ({ type: "tool_use", id: `toolu_${randomUUID().replaceAll("-", "").slice(0, 24)}`, name, input });

const HELLO = "Hi again, Alex. What can I help with today?";
const note = (index: number) => `Note ${index}: keep this for the planning doc.`;
const NOTES = 7;
const FLAKY = "What changed in the plan since yesterday?";
const FLAKY_ANSWER = "Since yesterday, the offsite moved to Lisbon.";
const SIDE = "Plan the quarterly offsite with me.";
const SIDE_ANSWER = "Noted: the offsite is in Lisbon. I'll keep that in mind.";
const SIDE_TITLE = "Quarterly offsite plan";
const MEMORY_FACT = "The quarterly offsite is in Lisbon.";
const RECALL = "Where is the offsite?";
const RECALL_ANSWER = "In Lisbon.";

async function listen(stack: AsyncDisposableStack, handle: RequestListener) {
  const server = createServer(handle);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  stack.defer(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Workbot fixture did not bind");
  return `http://127.0.0.1:${address.port}`;
}

async function bodyOf(request: AsyncIterable<Buffer | string>) {
  const chunks: Buffer[] = [];
  for await (const part of request) chunks.push(Buffer.isBuffer(part) ? part : Buffer.from(part));
  return Buffer.concat(chunks).toString("utf8");
}

function reply(response: ServerResponse, blocks: Block[], streamed: boolean) {
  const stop = blocks.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn";
  const message = { id: `msg_${randomUUID()}`, type: "message", role: "assistant", model: "workbot-journey", content: blocks,
    stop_reason: stop, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 20 } };
  if (!streamed) { response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(message)); return; }
  response.writeHead(200, { "content-type": "text/event-stream" });
  const send = (event: Record<string, unknown>) => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  send({ type: "message_start", message: { ...message, content: [], stop_reason: null } });
  for (const [index, block] of blocks.entries()) {
    send({ type: "content_block_start", index, content_block: block.type === "text" ? { type: "text", text: "" } : { ...block, input: {} } });
    send({ type: "content_block_delta", index, delta: block.type === "text" ? { type: "text_delta", text: block.text } : { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
    send({ type: "content_block_stop", index });
  }
  send({ type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 20 } });
  send({ type: "message_stop" });
  response.end();
}

const blocksOf = (message: Record<string, unknown>) => (Array.isArray(message.content) ? message.content.filter(record) : []);

/** Anthropic's own wording when a request breaks its rules, or null when the request is one it accepts. */
function refusalOf(messages: Array<Record<string, unknown>>): string | null {
  if (messages[0]?.role !== "user") return 'messages: first message must use the "user" role';
  for (const [index, message] of messages.entries()) {
    const previous = messages[index - 1];
    const calls = new Set(previous?.role === "assistant" ? blocksOf(previous).filter((block) => block.type === "tool_use").map((block) => String(block.id)) : []);
    for (const [position, block] of blocksOf(message).entries()) {
      if (block.type === "tool_result" && !calls.has(String(block.tool_use_id))) {
        return `messages.${index}.content.${position}: unexpected \`tool_use_id\` found in \`tool_result\` blocks: ${String(block.tool_use_id)}. Each \`tool_result\` block must have a corresponding \`tool_use\` block in the previous message.`;
      }
    }
    if (message.role !== "assistant") continue;
    const next = messages[index + 1];
    const answered = new Set(next ? blocksOf(next).filter((block) => block.type === "tool_result").map((block) => String(block.tool_use_id)) : []);
    const unanswered = blocksOf(message).find((block) => block.type === "tool_use" && next && !answered.has(String(block.id)));
    if (unanswered) return `messages.${index}: \`tool_use\` ids were found without \`tool_result\` blocks immediately after: ${String(unanswered.id)}. Each \`tool_use\` block must have a corresponding \`tool_result\` block in the next message.`;
  }
  return null;
}

/** A planning note's draft: long enough that seven of them outgrow the runner's 12,000-character context. */
const draft = (index: number) => `# Planning note ${index}\n\n${`Point ${index}: the venue, the dates and the budget still need a final yes from the team. `.repeat(16)}`;

export async function workbotConversations(_seed: Seed, context: { place: Place }) {
  if (context.place.kind !== "local") throw new Error("Workbot's isolated MySQL journey requires --local");
  const stack = new AsyncDisposableStack();
  const witness = {
    requests: 0,
    refused: 0,
    lastRefusal: "",
    /** Requests that no longer showed the conversation's first turn: what the model sees had been cut. */
    windowed: 0,
    noteAnswers: 0,
    flakyFailures: 0,
    /** How many copies of the flaky question the model saw when it finally answered it. */
    flakyCopies: 0,
    titleRequests: 0,
    sideSavedMemory: false,
    mainSawSideMemory: false,
  };
  try {
    const key = randomUUID();
    const upstream = await listen(stack, async (request, response) => {
      if (request.method !== "POST" || request.url !== "/v1/messages") { response.writeHead(404).end(); return; }
      if (request.headers["x-api-key"] !== key) { response.writeHead(401).end(); return; }
      try {
        const raw: unknown = JSON.parse(await bodyOf(request));
        if (!record(raw) || !Array.isArray(raw.messages)) throw new Error("Invalid model request");
        witness.requests += 1;
        const messages = raw.messages.filter(record);
        const system = JSON.stringify(raw.system ?? "");
        // Naming a side chat: a plain request with no tools.
        if (system.includes("You name conversations")) {
          witness.titleRequests += 1;
          reply(response, [text(SIDE_TITLE)], raw.stream === true);
          return;
        }
        const refusal = refusalOf(messages);
        if (refusal) {
          witness.refused += 1;
          witness.lastRefusal = refusal;
          const requestId = `req_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
          response.writeHead(400, { "content-type": "application/json", "request-id": requestId })
            .end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: refusal }, request_id: requestId }));
          return;
        }
        const userTexts = messages.filter((message) => message.role === "user").flatMap((message) => blocksOf(message).filter((block) => block.type === "text").map((block) => String(block.text)));
        const prompt = userTexts.at(-1) ?? "";
        const promptIndex = messages.findLastIndex((message) => message.role === "user" && blocksOf(message).some((block) => block.type === "text" && block.text === prompt));
        const current = messages.slice(Math.max(0, promptIndex));
        const called = (name: string) => current.some((message) => blocksOf(message).some((block) => block.type === "tool_use" && block.name === name));
        const transcript = JSON.stringify(messages);
        let blocks: Block[];
        if (prompt.includes("just opened Workbot for the first time")) blocks = [text(HELLO)];
        else if (/Note \d+: keep this/.test(prompt)) {
          const index = Number(/Note (\d+):/.exec(prompt)?.[1] ?? "0");
          if (!transcript.includes(HELLO)) witness.windowed += 1;
          const path = `notes/note-${index}.md`;
          if (!called("write_file")) blocks = [text("Saving it."), tool("write_file", { path, content: draft(index) })];
          else if (!called("read_file")) blocks = [tool("read_file", { path })];
          else {
            witness.noteAnswers += 1;
            blocks = [text(`Saved note ${index} to your planning notes. ${"It keeps the venue, the dates and the budget together for the team. ".repeat(8)}`)];
          }
        } else if (prompt.includes(FLAKY)) {
          if (witness.flakyFailures < 3) {
            // Three refusals in a row: the runner's own retries give up, and the answer fails.
            witness.flakyFailures += 1;
            response.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "api_error", message: "Internal server error" } }));
            return;
          }
          witness.flakyCopies = userTexts.filter((entry) => entry.includes(FLAKY)).length;
          blocks = [text(FLAKY_ANSWER)];
        } else if (prompt.includes(SIDE)) {
          if (!called("write_file")) blocks = [tool("write_file", { path: "memory/offsite.md", content: MEMORY_FACT })];
          else {
            witness.sideSavedMemory = transcript.includes("Wrote memory/offsite.md");
            blocks = [text(SIDE_ANSWER)];
          }
        } else if (prompt.includes(RECALL)) {
          witness.mainSawSideMemory = system.includes(MEMORY_FACT);
          blocks = [text(witness.mainSawSideMemory ? RECALL_ANSWER : "I don't know yet.")];
        } else blocks = [text("I can help with that.")];
        reply(response, blocks, raw.stream === true);
      } catch { response.writeHead(400).end(); }
    });
    const world = await bootWorkbot(stack, undefined, {
      live: false,
      upstream: { baseUrl: upstream, key, model: "workbot-journey" },
      runnerEnv: { HEADLESS_CONTEXT_CHAR_BUDGET: "12000" },
      features: { workbotSideChats: true },
    });
    const login = await signInWorkbot(world);
    const app = stack.use(await chrome({ name: "workbot-conversations", host: context.place.host(), headless: true, startUrl: "about:blank" }));
    await app.client.send("Network.setCookies", { cookies: login.cookie.split("; ").map((entry) => {
      const split = entry.indexOf("=");
      return { name: entry.slice(0, split), value: entry.slice(split + 1), url: world.workbotUrl, httpOnly: true, sameSite: "Lax" };
    }) });
    return {
      app, url: world.workbotUrl,
      hello: HELLO, note, notes: NOTES,
      flaky: FLAKY, flakyAnswer: FLAKY_ANSWER,
      side: SIDE, sideAnswer: SIDE_ANSWER, sideTitle: SIDE_TITLE, recall: RECALL, recallAnswer: RECALL_ANSWER,
      witness: () => ({ ...witness }),
      thread: async () => (await login.call("/v1/workbot?turns=30")).json(),
      chats: async () => (await login.call("/v1/workbot/chats")).json(),
      async [Symbol.asyncDispose]() { await stack.disposeAsync(); },
    };
  } catch (error) { await stack.disposeAsync(); throw error; }
}
