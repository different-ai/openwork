import { z } from "zod";
import {
  AGENT_INSTRUCTIONS,
  AGENT_RESPONSIBILITIES,
  agentWakePrompt,
  parseAgentReply,
  type AgentPromptSource,
  type AgentReply,
} from "../../../packages/automations/src/proactive.ts";

/**
 * Replay evals for Your agent: a recorded timeline (calendar, email and team chat as Connect would return them) is
 * served to a model as read-only tools, with the agent's real session instructions and wake prompt. The model's answer
 * is parsed with the agent's real reply parser and scored: did it message when it should, stay quiet otherwise, name
 * the right sources, connect what it was meant to connect, and write the way the instructions ask.
 *
 * The model is injected (`ReplayModel`), so the harness runs in unit tests with a scripted model and live with any
 * OpenAI-compatible chat completions endpoint (agent-replay.ts).
 */

export type ReplayEvent = {
  id: string;
  title: string;
  start: string;
  end: string;
  organizer: string;
  attendees: { email: string; self?: boolean; responseStatus?: "accepted" | "needsAction" | "declined" | "tentative" }[];
  status?: "confirmed" | "cancelled";
  updated: string;
  htmlLink: string;
};
export type ReplayEmailThread = {
  id: string;
  subject: string;
  link: string;
  messages: { from: string; to: string; at: string; text: string }[];
};
export type ReplayChatMessage = {
  channel: string;
  channelName: string;
  ts: string;
  /** How it reaches the person: a DM to them, a mention of them, or a thread they are in. */
  kind: "dm" | "mention" | "thread";
  from: string;
  at: string;
  text: string;
  permalink: string;
  replies?: { from: string; at: string; text: string }[];
};

export type ReplayTimeline = {
  id: string;
  /** What happened, in a line. */
  title: string;
  /** The wake's moment, with its UTC offset. */
  now: string;
  timeZone: string;
  morning: boolean;
  person: { name: string; email: string; slackName: string };
  /** When each source was last read (all the same in these timelines), or null for a first look. */
  lastReadAt: string | null;
  calendar: ReplayEvent[];
  email: ReplayEmailThread[];
  chat: ReplayChatMessage[];
  /** The agent's notes from earlier passes (`memory/notes.md`). */
  notes?: string;
  expect: {
    kind: "message" | "quiet";
    /** Sources the message's items must include. */
    sources?: string[];
    /** Every pattern must appear in the message (case-insensitive): what it must connect or say. */
    mentions?: { pattern: string; why: string }[];
    why: string;
  };
};

export type ReplayToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type ReplayMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ReplayToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };
export type ReplayToolSpec = { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } };
export type ReplayModel = (input: { messages: readonly ReplayMessage[]; tools: readonly ReplayToolSpec[] }) => Promise<{ content: string | null; tool_calls?: ReplayToolCall[] }>;

const MAX_STEPS = 16;
const SOURCES: AgentPromptSource[] = [
  { id: "calendar", name: "Calendar", via: ["Google Calendar"], instruction: "", lastReadAt: null },
  { id: "email", name: "Email", via: ["Gmail"], instruction: "", lastReadAt: null },
  { id: "chat", name: "Team chat", via: ["Slack"], instruction: "", lastReadAt: null },
];

const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const text = (description: string) => ({ type: "string", description });

/** The read-only tools the agent finds through Connect for these sources, named for what they do. */
export const REPLAY_TOOLS: ReplayToolSpec[] = [
  { type: "function", function: { name: "google_calendar_list_events", description: "Google Calendar: list the person's events between two times (ISO 8601).", parameters: object({ timeMin: text("Start, ISO 8601"), timeMax: text("End, ISO 8601") }, ["timeMin", "timeMax"]) } },
  { type: "function", function: { name: "gmail_search_threads", description: "Gmail: search the person's mail with Gmail search syntax (after:<unix seconds>, from:, subject:).", parameters: object({ query: text("Gmail search query") }, ["query"]) } },
  { type: "function", function: { name: "gmail_get_thread", description: "Gmail: read one thread's messages.", parameters: object({ threadId: text("Thread id") }, ["threadId"]) } },
  { type: "function", function: { name: "slack_search_public_and_private", description: "Slack: search messages the person can see: DMs to them, mentions of them and threads they're in. Supports after:YYYY-MM-DD.", parameters: object({ query: text("Slack search query") }, ["query"]) } },
  { type: "function", function: { name: "slack_read_thread", description: "Slack: read a message's thread replies.", parameters: object({ channel_id: text("Channel id"), message_ts: text("Parent message ts") }, ["channel_id", "message_ts"]) } },
  { type: "function", function: { name: "read_file", description: "Read one of your own scratch files, such as memory/notes.md.", parameters: object({ path: text("Path") }, ["path"]) } },
  { type: "function", function: { name: "write_file", description: "Write one of your own scratch files, such as memory/notes.md.", parameters: object({ path: text("Path"), content: text("Full content") }, ["path", "content"]) } },
];

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw || "{}");
    return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
  } catch {
    return {};
  }
}

const str = (value: unknown) => (typeof value === "string" ? value : "");

/** Gmail's `after:` as unix seconds or a date; anything else in the query is ignored (the fixture is small). */
function gmailAfter(query: string): number {
  const match = /after:(\S+)/.exec(query)?.[1];
  if (!match) return 0;
  if (/^\d+$/.test(match)) return Number(match) * 1000;
  const parsed = Date.parse(match.replaceAll("/", "-"));
  return Number.isFinite(parsed) ? parsed : 0;
}

function slackAfter(query: string): number {
  const match = /after:(\d{4}-\d{2}-\d{2})/.exec(query)?.[1];
  return match ? Date.parse(`${match}T00:00:00Z`) : 0;
}

/** Answers one tool call from the timeline, as Connect would: JSON, read only. */
export function answerTool(timeline: ReplayTimeline, files: Map<string, string>, name: string, rawArgs: string): string {
  const args = parseArgs(rawArgs);
  switch (name) {
    case "google_calendar_list_events": {
      const from = Date.parse(str(args.timeMin)) || 0;
      const to = Date.parse(str(args.timeMax)) || Number.POSITIVE_INFINITY;
      const items = timeline.calendar.filter((event) => Date.parse(event.end) > from && Date.parse(event.start) < to);
      return JSON.stringify({ timeZone: timeline.timeZone, items: items.map((event) => ({ ...event, status: event.status ?? "confirmed" })) });
    }
    case "gmail_search_threads": {
      const after = gmailAfter(str(args.query));
      const threads = timeline.email.filter((thread) => thread.messages.some((message) => Date.parse(message.at) >= after));
      return JSON.stringify({ threads: threads.map((thread) => ({ id: thread.id, subject: thread.subject, link: thread.link, last: thread.messages.at(-1) })) });
    }
    case "gmail_get_thread": {
      const thread = timeline.email.find((entry) => entry.id === str(args.threadId));
      return JSON.stringify(thread ?? { error: "not_found" });
    }
    case "slack_search_public_and_private": {
      const after = slackAfter(str(args.query));
      const messages = timeline.chat.filter((message) => Date.parse(message.at) >= after);
      return JSON.stringify({ messages: messages.map(({ replies, ...message }) => ({ ...message, reply_count: replies?.length ?? 0 })) });
    }
    case "slack_read_thread": {
      const parent = timeline.chat.find((message) => message.channel === str(args.channel_id) && message.ts === str(args.message_ts));
      return JSON.stringify(parent ? { messages: [{ from: parent.from, at: parent.at, text: parent.text }, ...(parent.replies ?? [])] } : { error: "not_found" });
    }
    case "read_file": {
      const content = files.get(str(args.path));
      return content === undefined ? JSON.stringify({ error: "not_found" }) : content;
    }
    case "write_file":
      files.set(str(args.path), str(args.content));
      return JSON.stringify({ ok: true });
    default:
      return JSON.stringify({ error: "unknown_tool" });
  }
}

/** The wake prompt Den would send for this timeline: a scheduled check with calendar, email and team chat. */
export function replayPrompt(timeline: ReplayTimeline): string {
  const lastReadAt = timeline.lastReadAt ? Date.parse(timeline.lastReadAt) : null;
  return agentWakePrompt({
    reasons: [{ kind: "scheduled", morning: timeline.morning }],
    sources: SOURCES.map((source) => ({ ...source, lastReadAt })),
    responsibilities: [...AGENT_RESPONSIBILITIES],
    instructions: "",
    now: Date.parse(timeline.now),
    timeZone: timeline.timeZone,
  });
}

export type ReplayRun = { reply: AgentReply; toolCalls: string[]; steps: number; finalText: string };

/** One pass of the agent over a timeline: the real instructions and prompt, the timeline's tools, the real parser. */
export async function runReplay(timeline: ReplayTimeline, model: ReplayModel): Promise<ReplayRun> {
  const files = new Map<string, string>(timeline.notes ? [["memory/notes.md", timeline.notes]] : []);
  const messages: ReplayMessage[] = [
    { role: "system", content: AGENT_INSTRUCTIONS },
    { role: "user", content: replayPrompt(timeline) },
  ];
  const toolCalls: string[] = [];
  for (let step = 1; step <= MAX_STEPS; step += 1) {
    const answer = await model({ messages, tools: REPLAY_TOOLS });
    const calls = answer.tool_calls ?? [];
    if (!calls.length) {
      const finalText = answer.content ?? "";
      return { reply: parseAgentReply(finalText), toolCalls, steps: step, finalText };
    }
    messages.push({ role: "assistant", content: answer.content, tool_calls: calls });
    for (const call of calls) {
      toolCalls.push(call.function.name);
      messages.push({ role: "tool", tool_call_id: call.id, content: answerTool(timeline, files, call.function.name, call.function.arguments) });
    }
  }
  return { reply: { kind: "invalid" }, toolCalls, steps: MAX_STEPS, finalText: "" };
}

/** How the instructions say a message must never read. */
const STYLE_RULES: { pattern: RegExp; rule: string }[] = [
  { pattern: /^\s*(Today|Waiting on a reply|Still open|FYI)\s*:/im, rule: "no category labels" },
  { pattern: /want me to draft|draft (a )?repl(y|ies) in workbot/i, rule: "no generic draft offer" },
  { pattern: /^#{1,6} |\*\*/m, rule: "no headers or bold labels" },
  { pattern: /<!(channel|here|everyone)>|(^|\s)@(channel|here|everyone)\b/i, rule: "never mentions anyone" },
];

export type ReplayVerdict = { pass: boolean; reply: AgentReply["kind"]; failures: string[]; message: string | null };

/** Scores one run against what the timeline expects. */
export function scoreReplay(timeline: ReplayTimeline, run: ReplayRun): ReplayVerdict {
  const failures: string[] = [];
  const { reply } = run;
  const message = reply.kind === "message" ? reply.message : null;
  if (timeline.expect.kind === "quiet") {
    if (reply.kind !== "quiet") failures.push(`should stay quiet (${timeline.expect.why}), answered ${reply.kind}`);
  } else if (reply.kind !== "message") {
    failures.push(`should message (${timeline.expect.why}), answered ${reply.kind}`);
  } else {
    const sources = new Set(reply.items.map((item) => item.source));
    for (const item of reply.items) if (!["calendar", "email", "chat"].includes(item.source)) failures.push(`item from an unknown source: ${item.source}`);
    for (const source of timeline.expect.sources ?? []) if (!sources.has(source)) failures.push(`items should include ${source}`);
    for (const mention of timeline.expect.mentions ?? []) {
      if (!new RegExp(mention.pattern, "i").test(reply.message)) failures.push(`should say ${mention.why} (/${mention.pattern}/)`);
    }
    for (const rule of STYLE_RULES) if (rule.pattern.test(reply.message)) failures.push(`style: ${rule.rule}`);
  }
  return { pass: failures.length === 0, reply: reply.kind, failures, message };
}

const toolCallSchema = z.object({ id: z.string(), type: z.literal("function").default("function"), function: z.object({ name: z.string(), arguments: z.string().default("{}") }) });
const completionSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable().optional(), tool_calls: z.array(toolCallSchema).nullable().optional() }) })).min(1),
});

/** A model behind any OpenAI-compatible chat completions endpoint (OpenAI, Vercel AI Gateway, a local proxy). */
export function chatCompletionsModel(input: { baseUrl: string; apiKey: string; model: string; fetch?: typeof fetch }): ReplayModel {
  const call = input.fetch ?? fetch;
  return async ({ messages, tools }) => {
    const response = await call(`${input.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${input.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: input.model, messages, tools, tool_choice: "auto" }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!response.ok) throw new Error(`Model call failed: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
    const parsed = completionSchema.parse(await response.json());
    const message = parsed.choices[0]?.message;
    const toolCalls = message?.tool_calls ?? [];
    return { content: message?.content ?? null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) };
  };
}
