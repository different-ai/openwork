export const summary = "Workbot for the phone app: the seeded Acme Den (sign in as alex@acme.test), the headless runner and this checkout's Workbot, with the phone app and side chats on and a scripted model that greets, answers in Markdown and runs a background job; -- --calendar adds the Calendar with seeded Automations.";
export const supportedTargets = ["local/host"];

import { createServer, type IncomingMessage, type RequestListener, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { hold } from "../../../../packages/world/src/hold.ts";
import { output, secret } from "../../../../packages/world/src/outputs.ts";
import { startCalendarMockProcess } from "../../../../worlds/lib/calendar.ts";
import { bootWorkbot } from "../../../../worlds/lib/workbot.ts";

const NAME = "workbot-phone";

/** What Workbot says, scripted by what it was asked: enough to see every kind of answer on the phone. */
const HELLO = [
  "Hi Alex.",
  "",
  "You have **Launch review** at 2:00 PM, and two emails are waiting on you: Jordan asked about the pricing page, and Sam needs the Q4 numbers.",
  "",
  "Want me to draft replies to both?",
  "",
  "Next: Draft both replies | Plan my afternoon | Catch me up on Slack",
].join("\n");
const ANSWER = [
  "Here's where things stand:",
  "",
  "- **Launch review** at 2:00 PM with the design team",
  "- **Pricing page**: Jordan is waiting on your notes",
  "- **Q4 numbers**: Sam asked for them by Friday",
  "",
  "Want me to draft the reply to Jordan first?",
].join("\n");
const JOB_TITLE = "Launch brief";
const CHILD = "WORKBOT_PHONE_BRIEF";

type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
const text = (value: string): Block => ({ type: "text", text: value });
const tool = (name: string, input: Record<string, unknown>): Block => ({ type: "tool_use", id: `call_${randomUUID()}`, name, input });

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function bodyOf(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const part of request) chunks.push(Buffer.isBuffer(part) ? part : Buffer.from(String(part)));
  return Buffer.concat(chunks).toString("utf8");
}

async function listen(stack: AsyncDisposableStack, handle: RequestListener) {
  const server = createServer(handle);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  stack.defer(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The scripted model did not bind");
  return `http://127.0.0.1:${address.port}`;
}

/** An Anthropic Messages reply, streamed in small pieces so the phone shows the answer being written. */
async function reply(response: ServerResponse, blocks: Block[], streamed: boolean) {
  const stop = blocks.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn";
  const message = { id: `msg_${randomUUID()}`, type: "message", role: "assistant", model: "workbot-phone", content: blocks, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 20 } };
  if (!streamed) { response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(message)); return; }
  response.writeHead(200, { "content-type": "text/event-stream" });
  const send = (event: Record<string, unknown>) => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  send({ type: "message_start", message: { ...message, content: [], stop_reason: null } });
  for (const [index, block] of blocks.entries()) {
    send({ type: "content_block_start", index, content_block: block.type === "text" ? { type: "text", text: "" } : { ...block, input: {} } });
    if (block.type === "text") {
      for (let at = 0; at < block.text.length; at += 12) {
        if (response.destroyed) return;
        send({ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text.slice(at, at + 12) } });
        await delay(25);
      }
    } else {
      send({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
    }
    send({ type: "content_block_stop", index });
  }
  send({ type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 20 } });
  send({ type: "message_stop" });
  response.end();
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  for (const arg of argv) if (arg !== "--calendar") throw new Error(`${NAME}: unknown option ${arg} (supported: --calendar)`);
  const calendar = argv.includes("--calendar");
  await using stack = new AsyncDisposableStack();
  const key = randomUUID();
  const upstream = await listen(stack, async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/messages") { response.writeHead(404).end(); return; }
    if (request.headers["x-api-key"] !== key) { response.writeHead(401).end(); return; }
    try {
      const raw: unknown = JSON.parse(await bodyOf(request));
      if (!record(raw) || !Array.isArray(raw.messages)) throw new Error("Invalid model request");
      const messages = raw.messages.filter(record);
      const parts = (message: Record<string, unknown> | undefined) => (message && Array.isArray(message.content) ? message.content.filter(record) : []);
      // The person's own message: the newest user message with words in it and no tool results.
      const person = messages.findLast((message) => message.role === "user" && parts(message).some((part) => part.type === "text") && !parts(message).some((part) => part.type === "tool_result"));
      const prompt = parts(person).filter((part) => part.type === "text").map((part) => String(part.text)).join("\n");
      // Each step follows from the one before it: the last tool the model called, if the request ends with its result.
      const last = messages.at(-1);
      const afterTool = last?.role === "user" && parts(last).some((part) => part.type === "tool_result");
      const lastTool = afterTool ? parts(messages.at(-2)).filter((part) => part.type === "tool_use").map((part) => String(part.name)).at(-1) ?? null : null;
      const asked = prompt.toLowerCase();
      let blocks: Block[];
      if (prompt.includes("just opened Workbot for the first time")) blocks = [text(HELLO)];
      else if (prompt.includes(CHILD)) {
        // The background job: real work on the runner, long enough to keep chatting meanwhile.
        if (!lastTool) {
          await delay(8_000);
          if (response.destroyed) return;
          blocks = [tool("write_file", { path: "launch-brief.md", content: "# Launch brief\n\n- **What**: Acme Robotics' spring launch\n- **When**: Tuesday, 9:00 AM\n- **Who**: design, sales and support\n\nThe launch is ready for a team review.\n" })];
        } else if (lastTool === "write_file") blocks = [tool("save_file", { path: "launch-brief.md" })];
        else blocks = [text("The launch brief is saved and ready to open.")];
      } else if (prompt.startsWith("[Background task")) {
        blocks = [text(prompt.includes("stopped before finishing") ? "I couldn't finish the brief." : "Your launch brief is ready. It's in your files: open launch-brief.md.")];
      } else if (/brief|draft/.test(asked)) {
        blocks = lastTool === "start_task" ? [text("On it: I'm drafting the launch brief. Keep chatting; I'll come back with it.")] : [tool("start_task", { title: JOB_TITLE, brief: `${CHILD}: draft and save launch-brief.md.` })];
      } else if (/thank/.test(asked)) blocks = [tool("react", { emoji: "❤️", final: true })];
      else if (/good news|great news/.test(asked)) blocks = lastTool === "react" ? [text("That's great to hear! Want me to tell the team?")] : [tool("react", { emoji: "🎉" })];
      else if (asked.includes("two plus two")) blocks = [text("Four.")];
      else blocks = [text(ANSWER)];
      await reply(response, blocks.length ? blocks : [text("")], raw.stream === true);
    } catch {
      response.writeHead(400).end();
    }
  });
  const mock = calendar ? await startCalendarMockProcess(stack) : null;
  const world = await bootWorkbot(stack, undefined, {
    live: false,
    calendar,
    upstream: { baseUrl: upstream, key, model: "workbot-phone" },
    features: { workbotMobile: true, workbotSideChats: true },
    ...(mock ? { workbotCalendarMockUrl: mock.baseUrl } : {}),
  });
  await hold({
    name: NAME,
    outputs: {
      workbotUrl: output(world.workbotUrl, { group: "Phone app", note: "Point the development build here (sign-in screen: Change)" }),
      denWeb: output(world.denWebPublic, { group: "Phone app", note: "Den's sign-in, opened by the phone's sign-in browser" }),
      alexEmail: output(world.den.admin.email, { group: "Accounts", note: "Sign in with this on the phone" }),
      alexPassword: secret(world.den.admin.password, { group: "Accounts" }),
      try: output(`Say anything; "Draft the launch brief" starts a background job; "thanks" and "good news" get reactions.`, { group: "Phone app" }),
    },
  });
}

if (import.meta.main) await main();
