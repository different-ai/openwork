import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { ACME_MODEL, record } from "./acme-gateway.ts";

/**
 * A scripted stand-in for the model behind Workbot in `--open-workplace` worlds, speaking the Anthropic Messages API
 * behind the real AI Gateway. It does not reason: for a few fixed requests it calls the same tools a model gets
 * (`search_capabilities`, then `execute_capability` on Den's Microsoft 365 capabilities) and reports what came back.
 * So a proof exercises Workbot's real path (runner → Den MCP → Microsoft 365 connector → the person's Open Workplace)
 * deterministically and without a paid key. Anything else gets a plain reply saying what it can do.
 *
 *   find the meeting "<subject>"
 *   move the meeting "<subject>" to <UTC ISO start>          (keeps the length; confirms attendee notifications)
 *   reply to the email "<subject>" with "<text>"             (saves a reply draft; never sends)
 *   save "<text>" to OneDrive as "<path>"
 *   find the file "<name>"
 */
export const WORKPLACE_AGENT_HELP = "I can find a meeting, move a meeting, draft a reply to an email, and save or find a OneDrive file.";

type Call = { tool: "search_capabilities" | "execute_capability"; input: Record<string, unknown> };
type Step = (results: unknown[]) => Call | string;

/** The JSON a tool returned: MCP text content holding a capability's response. */
function parseResult(content: unknown): unknown {
  const text = typeof content === "string" ? content
    : Array.isArray(content) ? content.map((part) => record(part) && typeof part.text === "string" ? part.text : "").join("\n") : "";
  const start = text.indexOf("{");
  if (start < 0) return text;
  try { return JSON.parse(text.slice(start)); } catch { return text; }
}

function capability(result: unknown, method: string, path: string): string | null {
  const matches = record(result) && Array.isArray(result.matches) ? result.matches.filter(record) : [];
  const found = matches.find((match) => match.method === method && match.path === path);
  return typeof found?.name === "string" ? found.name : null;
}

function list(result: unknown, key: string): Record<string, unknown>[] {
  const value = record(result) ? result[key] : undefined;
  return Array.isArray(value) ? value.filter(record) : [];
}

function child(result: unknown, key: string): Record<string, unknown> | null {
  const value = record(result) ? result[key] : undefined;
  return record(value) ? value : null;
}

const failure = (result: unknown) => record(result) && typeof result.message === "string" ? result.message : record(result) && typeof result.error === "string" ? result.error : "the request failed";

/** Search for one capability, then run it; `then` continues with its result. */
function use(query: string, method: string, path: string, input: (results: unknown[]) => Record<string, unknown>): Step[] {
  return [
    () => ({ tool: "search_capabilities", input: { query, limit: 10 } }),
    (results) => {
      const name = capability(results.at(-1), method, path);
      return name ? { tool: "execute_capability", input: { name, ...input(results) } } : `I couldn't find the ${method} ${path} capability in your connected apps.`;
    },
  ];
}

const DAY = 24 * 60 * 60 * 1000;
const range = () => ({ timeMin: new Date(Date.now() - 60 * DAY).toISOString(), timeMax: new Date(Date.now() + 180 * DAY).toISOString(), maxResults: 100 });
const LIST_EVENTS = ["list Microsoft 365 calendar events", "GET", "/v1/capabilities/microsoft-365/calendar-events"] as const;

function eventNamed(result: unknown, subject: string) {
  return list(result, "events").find((event) => typeof event.subject === "string" && event.subject.toLowerCase() === subject.toLowerCase());
}

/** The fixed plan for one request, or null when the request is not one of the scripted ones. */
export function workplacePlan(request: string): Step[] | null {
  const quoted = [...request.matchAll(/"([^"]{1,500})"/g)].map((match) => match[1] ?? "");
  const [first = "", second = ""] = quoted;
  if (/^\s*find the meeting "/i.test(request)) {
    return [
      ...use(...LIST_EVENTS, () => ({ query: range() })),
      (results) => {
        const read = results.at(-1);
        if (!record(read) || !Array.isArray(read.events)) return `I couldn't read your calendar: ${failure(read)}.`;
        const event = eventNamed(read, first);
        return event ? `"${String(event.subject)}" is on your Outlook calendar from ${String(event.start)} to ${String(event.end)}.` : `I couldn't find a meeting called "${first}" on your calendar.`;
      },
    ];
  }
  const move = request.match(/^\s*move the meeting "[^"]+" to (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z)/i);
  if (move?.[1]) {
    const start = new Date(move[1]);
    return [
      ...use(...LIST_EVENTS, () => ({ query: range() })),
      (results) => eventNamed(results.at(-1), first) ? { tool: "search_capabilities", input: { query: "reschedule Outlook calendar event", limit: 10 } } : `I couldn't find a meeting called "${first}" on your calendar.`,
      (results) => {
        const event = eventNamed(results.at(-2), first);
        const name = capability(results.at(-1), "PATCH", "/v1/capabilities/microsoft-365/calendar-events/{eventId}");
        if (!event || !name) return "I couldn't find how to reschedule Outlook events in your connected apps.";
        const length = Date.parse(String(event.end)) - Date.parse(String(event.start));
        return { tool: "execute_capability", input: { name, path: { eventId: String(event.id) }, body: { confirmNotifications: true, start: start.toISOString(), end: new Date(start.getTime() + length).toISOString() } } };
      },
      (results) => {
        const updated = child(results.at(-1), "event");
        return updated ? `Moved "${String(updated.subject)}" to ${String(updated.start)}.` : `I couldn't move the meeting: ${failure(results.at(-1))}.`;
      },
    ];
  }
  if (/^\s*reply to the email "/i.test(request) && second) {
    return [
      ...use("list or search Outlook mail", "GET", "/v1/capabilities/microsoft-365/mail-messages", () => ({ query: { search: first, maxResults: 10 } })),
      (results) => list(results.at(-1), "messages").some((message) => message.subject === first) ? { tool: "search_capabilities", input: { query: "reply draft Outlook message", limit: 10 } } : `I couldn't find an email called "${first}".`,
      (results) => {
        const message = list(results.at(-2), "messages").find((entry) => entry.subject === first);
        const name = capability(results.at(-1), "POST", "/v1/capabilities/microsoft-365/mail-message/{messageId}/reply-draft");
        if (!message || !name) return "I couldn't find how to draft Outlook replies in your connected apps.";
        return { tool: "execute_capability", input: { name, path: { messageId: String(message.id) }, body: { comment: second } } };
      },
      (results) => child(results.at(-1), "draft") ? `Saved a reply draft to "${first}" in your Outlook Drafts. I didn't send it.` : `I couldn't save the draft: ${failure(results.at(-1))}.`,
    ];
  }
  if (/^\s*save "/i.test(request) && /onedrive as "/i.test(request) && second) {
    return [
      ...use("create or replace a OneDrive text file", "PUT", "/v1/capabilities/microsoft-365/drive-files", () => ({ body: { path: second, content: first } })),
      (results) => child(results.at(-1), "file") ? `Saved ${second} to your OneDrive.` : `I couldn't save the file: ${failure(results.at(-1))}.`,
    ];
  }
  if (/^\s*find the file "/i.test(request)) {
    return [
      ...use("search OneDrive files", "GET", "/v1/capabilities/microsoft-365/drive-files", () => ({ query: { query: first, maxResults: 10 } })),
      (results) => {
        const files = list(results.at(-1), "files").filter((file) => typeof file.name === "string" && file.name.toLowerCase().includes(first.toLowerCase()));
        return files.length ? `Found ${files.map((file) => String(file.name)).join(", ")} in your OneDrive.` : `I couldn't find a file called "${first}" in your OneDrive.`;
      },
    ];
  }
  return null;
}

type Message = { role: string; content: unknown };

/** Where the conversation stands: the latest request and the tool results since. */
export function workplaceTurn(messages: readonly Message[]) {
  let request = "";
  const results: unknown[] = [];
  for (const message of messages) {
    const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : Array.isArray(message.content) ? message.content.filter(record) : [];
    if (message.role !== "user") continue;
    const toolResults = blocks.filter((block) => block.type === "tool_result");
    if (toolResults.length) { for (const block of toolResults) results.push(parseResult(block.content)); continue; }
    const text = blocks.filter((block) => block.type === "text" && typeof block.text === "string").map((block) => String(block.text)).join("\n").trim();
    if (text) { request = text; results.length = 0; }
  }
  return { request, results };
}

/** The next model output for this conversation: a tool call or the final text. */
export function workplaceNext(messages: readonly Message[], tools: readonly string[]): { text: string } | { tool: string; input: Record<string, unknown> } {
  const { request, results } = workplaceTurn(messages);
  // The request may carry Workbot's own framing around the person's words; take the last line that matches.
  const line = request.split("\n").map((part) => part.trim()).reverse().find((part) => workplacePlan(part)) ?? request;
  const plan = workplacePlan(line);
  if (!plan) return { text: `Acme AI Gateway is working. ${WORKPLACE_AGENT_HELP}` };
  const step = plan[results.length];
  if (!step) return { text: "Done." };
  const next = step(results);
  if (typeof next === "string") return { text: next };
  const tool = tools.find((name) => name === next.tool || name.endsWith(`_${next.tool}`) || name.endsWith(`__${next.tool}`));
  return tool ? { tool, input: next.input } : { text: "I can't reach your connected apps from here." };
}

/** The scripted model as an Anthropic-compatible upstream for the AI Gateway (same key and model as the Acme one). */
export async function startWorkplaceAgent(stack: AsyncDisposableStack) {
  const key = randomUUID();
  const calls: { tool: string; input: Record<string, unknown> }[] = [];
  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url?.split("?")[0] === "/v1/models") {
        if (request.headers["x-api-key"] !== key) { response.writeHead(401).end(); return; }
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: ACME_MODEL, name: ACME_MODEL }] }));
        return;
      }
      if (request.method !== "POST" || request.url?.split("?")[0] !== "/v1/messages") { response.writeHead(404).end(); return; }
      if (request.headers["x-api-key"] !== key) { response.writeHead(401).end(); return; }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!record(body) || body.model !== ACME_MODEL || !Array.isArray(body.messages)) { response.writeHead(400).end(); return; }
      const messages = body.messages.filter(record).map((message) => ({ role: String(message.role), content: message.content }));
      const tools = Array.isArray(body.tools) ? body.tools.filter(record).map((tool) => String(tool.name)) : [];
      const next = workplaceNext(messages, tools);
      if ("tool" in next) calls.push(next);
      const block = "tool" in next ? { type: "tool_use", id: `toolu_${randomUUID().replaceAll("-", "")}`, name: next.tool, input: next.input } : { type: "text", text: next.text };
      const stop = "tool" in next ? "tool_use" : "end_turn";
      const message = { id: `msg_${randomUUID()}`, type: "message", role: "assistant", model: ACME_MODEL, content: [block], stop_reason: stop, stop_sequence: null, usage: { input_tokens: 40, output_tokens: 20 } };
      if (body.stream !== true) { response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(message)); return; }
      response.writeHead(200, { "content-type": "text/event-stream", "request-id": randomUUID() });
      const events = [
        { type: "message_start", message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 40, output_tokens: 0 } } },
        block.type === "tool_use"
          ? { type: "content_block_start", index: 0, content_block: { ...block, input: {} } }
          : { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        block.type === "tool_use"
          ? { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } }
          : { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: block.text } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 20 } },
        { type: "message_stop" },
      ];
      for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      response.end();
    } catch {
      if (!response.headersSent) response.writeHead(400);
      response.end();
    }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  stack.defer(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Workplace agent did not bind.");
  return { baseUrl: `http://127.0.0.1:${address.port}`, key, model: ACME_MODEL, calls: () => [...calls] };
}
