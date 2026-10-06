import { createServer, type RequestListener, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { chrome } from "@openwork/hosts";
import type { Place, Seed } from "@openwork/env";
import { bootWorkbot, signInWorkbot } from "../../worlds/lib/workbot.ts";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
const text = (value: string): Block => ({ type: "text", text: value });
const tool = (name: string, input: Record<string, unknown>): Block => ({ type: "tool_use", id: `call_${randomUUID()}`, name, input });
const HELLO = "Hi again, Alex. Your apps are connected. What can I help with today?";
const JOB = "Draft the launch brief while I keep chatting.";
const TITLE = "Launch brief";
const CHILD = "WORKBOT_JOURNEY_BRIEF";

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

/** Real Workbot, runner, OAuth and Den; only the model and connected providers are deterministic. */
export async function workbotFirstUse(_seed: Seed, context: { place: Place }, failure: "none" | "start" | "model" = "none") {
  if (context.place.kind !== "local") throw new Error("Workbot's isolated MySQL journey requires --local");
  const stack = new AsyncDisposableStack();
  const witness = { greetingRequests: 0, greetingWritesRejected: false, greetingLocalWritesRejected: false, tokenEscalationBlocked: false, taskRequests: 0, titleStayedOutOfSystem: true, rejectedStarts: 0, rejectedGreetingModels: 0 };
  try {
    const key = randomUUID();
    const upstream = await listen(stack, async (request, response) => {
      if (request.method !== "POST" || request.url !== "/v1/messages") { response.writeHead(404).end(); return; }
      if (request.headers["x-api-key"] !== key) { response.writeHead(401).end(); return; }
      try {
        const raw: unknown = JSON.parse(await bodyOf(request));
        if (!record(raw) || !Array.isArray(raw.messages)) throw new Error("Invalid model request");
        const messages = raw.messages.filter(record);
        const userTexts = messages.filter((message) => message.role === "user").flatMap((message) => Array.isArray(message.content) ? message.content.filter(record).filter((part) => part.type === "text").map((part) => String(part.text)) : []);
        const prompt = userTexts.at(-1) ?? "";
        const transcript = JSON.stringify(messages);
        const promptIndex = messages.findLastIndex((message) => message.role === "user" && Array.isArray(message.content) && message.content.some((part) => record(part) && part.type === "text" && part.text === prompt));
        const current = messages.slice(Math.max(0, promptIndex));
        const called = (name: string) => current.some((message) => Array.isArray(message.content) && message.content.some((part) => record(part) && part.type === "tool_use" && part.name === name));
        if (transcript.includes(TITLE)) witness.titleStayedOutOfSystem &&= !JSON.stringify(raw.system).includes(TITLE);
        let blocks: Block[];
        if (prompt.includes("just opened Workbot for the first time")) {
          witness.greetingRequests += 1;
          if (failure === "model" && witness.rejectedGreetingModels === 0) {
            witness.rejectedGreetingModels += 1;
            response.writeHead(401).end();
            return;
          }
          // An adversarial model asks to write anyway: Den's token scope must refuse it.
          if (!called("create_skill")) blocks = [tool("create_skill", { pluginName: "Greeting must not write", skillMarkdown: "---\nname: greeting-write\ndescription: Synthetic denied write\n---\nThis skill must never be saved." })];
          else if (!called("write_file")) {
            witness.greetingWritesRejected = /scope|forbidden|read.only|permission|unauthoriz|unknown tool|not available/i.test(transcript);
            blocks = [tool("write_file", { path: "memory/greeting-probe.txt", content: "This automatic greeting must not save memory." })];
          } else {
            witness.greetingLocalWritesRejected = transcript.includes("read_only_turn");
            blocks = [text(HELLO)];
          }
        } else if (prompt.includes(CHILD)) {
          witness.taskRequests += 1;
          witness.titleStayedOutOfSystem &&= !JSON.stringify(raw.system).includes(TITLE);
          if (prompt.includes("PROVIDER_FAIL")) { response.writeHead(401).end(); return; }
          if (!called("write_file")) {
            // Hold real work long enough for the member to ask a second question and stop another job.
            await delay(20_000);
            if (response.destroyed) return;
            blocks = [tool("write_file", { path: "launch-brief.md", content: "# Launch brief\n\nThe Acme launch is ready for a team review.\n" })];
          } else if (!called("save_file")) blocks = [tool("save_file", { path: "launch-brief.md" })];
          else blocks = [text("The launch brief is saved and ready to open.")];
        } else if (prompt.startsWith("[Background task")) blocks = [text(prompt.includes("stopped before finishing") ? "I couldn't finish the brief. The model was unavailable." : "Your launch brief is ready. Open launch-brief.md in Files.")];
        else if (prompt === JOB) blocks = called("start_task") ? [text("I'm drafting the launch brief. You can keep chatting.")] : [tool("start_task", { title: TITLE, brief: `${CHILD}: draft and save launch-brief.md.` })];
        else if (prompt === "Draft another brief with the unavailable provider.") blocks = called("start_task") ? [text("I'm drafting another brief.")] : [tool("start_task", { title: "Another brief", brief: `${CHILD} PROVIDER_FAIL: draft another brief.` })];
        else if (prompt === 'Try the "Another brief" background task again.') blocks = called("start_task") ? [text("I'm trying the brief again.")] : [tool("start_task", { title: "Retry the brief", brief: `${CHILD}: draft and save launch-brief.md.` })];
        else if (prompt === "What is two plus two?") blocks = [text("Four.")];
        else blocks = [text("I can help with that.")];
        reply(response, blocks, raw.stream === true);
      } catch { response.writeHead(400).end(); }
    });
    let denApi = "";
    const world = await bootWorkbot(stack, undefined, {
      live: false, upstream: { baseUrl: upstream, key, model: "workbot-journey" },
      runnerProxy: async (runnerUrl: string) => listen(stack, async (request, response) => {
        const body = await bodyOf(request);
        if (failure === "start" && request.method === "POST" && request.url?.endsWith("/turns") && witness.rejectedStarts === 0) {
          witness.rejectedStarts += 1;
          response.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: "runner_unavailable" }));
          return;
        }
        const payload: unknown = body ? JSON.parse(body) : null;
        if (record(payload) && record(payload.credentials) && payload.credentials.readOnly === true && typeof payload.credentials.mcpToken === "string") {
          const escalation = await fetch(`${denApi}/v1/workbot/run-token`, { method: "POST", headers: { authorization: `Bearer ${payload.credentials.mcpToken}`, "content-type": "application/json" }, body: JSON.stringify({ readOnly: false }) });
          witness.tokenEscalationBlocked = escalation.status === 403;
          await escalation.arrayBuffer();
        }
        const upstreamResponse = await fetch(`${runnerUrl}${request.url}`, { method: request.method, headers: { authorization: request.headers.authorization ?? "", "content-type": "application/json" }, ...(body ? { body } : {}) });
        response.writeHead(upstreamResponse.status, { "content-type": upstreamResponse.headers.get("content-type") ?? "application/json" });
        const reader = upstreamResponse.body?.getReader();
        if (!reader) { response.end(); return; }
        response.on("close", () => { void reader.cancel().catch(() => undefined); });
        while (!response.destroyed) {
          const chunk = await reader.read();
          if (chunk.done) break;
          response.write(chunk.value);
        }
        response.end();
      }),
    });
    denApi = world.den.ref.apiUrl;
    const login = await signInWorkbot(world);
    const app = stack.use(await chrome({ name: "workbot-first-use", host: context.place.host(), headless: true, startUrl: "about:blank" }));
    await app.client.send("Network.setCookies", { cookies: login.cookie.split("; ").map((entry) => {
      const split = entry.indexOf("=");
      return { name: entry.slice(0, split), value: entry.slice(split + 1), url: world.workbotUrl, httpOnly: true, sameSite: "Lax" };
    }) });
    return {
      app, url: world.workbotUrl, hello: HELLO, job: JOB, title: TITLE,
      witness: () => ({ ...witness }),
      thread: async () => (await login.call("/v1/workbot?turns=30")).json(),
      files: async () => (await login.call("/v1/workbot/files")).json(),
      anonymousStatus: async () => (await fetch(`${world.workbotUrl}/v1/workbot`)).status,
      async [Symbol.asyncDispose]() { await stack.disposeAsync(); },
    };
  } catch (error) { await stack.disposeAsync(); throw error; }
}

export async function workbotGreetingRecovery(seed: Seed, context: { place: Place }) {
  return workbotFirstUse(seed, context, "start");
}

export async function workbotModelGreetingRecovery(seed: Seed, context: { place: Place }) {
  return workbotFirstUse(seed, context, "model");
}
