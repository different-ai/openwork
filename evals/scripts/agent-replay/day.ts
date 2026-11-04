import type { ReplayToolCall, ReplayToolSpec } from "./harness.ts";

/**
 * A recorded day (or two) for Your agent's replay evals: calendar, Gmail, Slack and GitHub as Connect returns them,
 * each item visible from the moment it happened, so every check of the day reads only what existed then. Fictional
 * people and companies on `.example` domains. Both pipelines (today's prompts and the brief's) read the same world
 * through the same read-only tools.
 */

export type DayEvent = {
  id: string;
  title: string;
  start: string;
  end: string;
  organizer: string;
  attendees: { email: string; self?: boolean; responseStatus?: "accepted" | "needsAction" | "declined" | "tentative" }[];
  status?: "confirmed" | "cancelled";
  updated: string;
  htmlLink: string;
  /** When this version appeared (another version of the same id before it is what the calendar showed until then). */
  visibleAt?: string;
  /** A change someone else made, for today's calendar wakes. */
  change?: { kind: "added" | "moved" | "cancelled"; previousStart?: string };
};
export type DayEmailThread = { id: string; subject: string; link: string; messages: { from: string; to: string; at: string; text: string }[] };
export type DayChatMessage = {
  channel: string;
  channelName: string;
  ts: string;
  kind: "dm" | "mention" | "thread";
  from: string;
  at: string;
  text: string;
  permalink: string;
  replies?: { from: string; at: string; text: string }[];
};
export type DayGithubItem = {
  id: string;
  repo: string;
  type: "PullRequest" | "Issue" | "SecurityAlert";
  number: number;
  title: string;
  url: string;
  reason: string;
  at: string;
  state?: "open" | "closed" | "fixed";
  body: string;
  comments?: { from: string; at: string; text: string }[];
};

export type DayExpectation = {
  /**
   * Must be told: a message matching `match` sent at a check no later than `by`; with `again`, once more after
   * `again.after` and no later than `again.by` (a nudge, "still unresolved"). Any other repeat is an interruption.
   */
  must: { id: string; match: string; by: string; why: string; again?: { after: string; by: string } }[];
  /** Fine to mention, not required: not counted as an interruption, never missed. */
  ok?: { match: string; why: string }[];
  /** Never worth a message. */
  never?: { match: string; why: string }[];
  /** For a quiet scenario: nothing at all. */
  silent?: boolean;
};

export type DayScenario = {
  id: string;
  title: string;
  person: { name: string; first: string; email: string; slackName: string };
  timeZone: string;
  /** Local days and hours the checks happen in (the brief's rhythm and today's schedule both run inside them). */
  windows: { date: string; from: number; to: number }[];
  /** The member's own lines (the brief) and the same as today's words (legacy `always/never/when/how`). */
  memberLines?: string;
  memberWords?: { always?: string; never?: string; when?: string; how?: string };
  /** The agent's notes before the first check (memory/notes.md). */
  notes?: string;
  calendar: DayEvent[];
  email: DayEmailThread[];
  chat: DayChatMessage[];
  github?: DayGithubItem[];
  /** What the member writes in their Workbot DM, and when. */
  memberSays?: { at: string; text: string }[];
  expect: DayExpectation;
};

const parsed = (iso: string) => Date.parse(iso);
const visible = (at: string | undefined, now: number) => at === undefined || parsed(at) <= now;

/** The calendar as it stood at `now`: the newest visible version of each event. */
export function calendarAt(scenario: DayScenario, now: number): DayEvent[] {
  const byId = new Map<string, DayEvent>();
  for (const event of scenario.calendar) {
    if (!visible(event.visibleAt, now)) continue;
    const seen = byId.get(event.id);
    if (!seen || parsed(event.visibleAt ?? "1970-01-01T00:00:00Z") >= parsed(seen.visibleAt ?? "1970-01-01T00:00:00Z")) byId.set(event.id, event);
  }
  return [...byId.values()];
}

const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const text = (description: string) => ({ type: "string", description });

/** The read-only tools both pipelines get, named as Connect lists them; plus the agent's own scratch files. */
export function dayTools(scenario: DayScenario, extra: ReplayToolSpec[] = []): ReplayToolSpec[] {
  return [
    { type: "function", function: { name: "google_calendar_list_events", description: "Google Calendar: list the person's events between two times (ISO 8601).", parameters: object({ timeMin: text("Start, ISO 8601"), timeMax: text("End, ISO 8601") }, ["timeMin", "timeMax"]) } },
    { type: "function", function: { name: "gmail_search_threads", description: "Gmail: search the person's mail with Gmail search syntax (after:<unix seconds>, in:sent, from:, to:, subject:).", parameters: object({ query: text("Gmail search query") }, ["query"]) } },
    { type: "function", function: { name: "gmail_get_thread", description: "Gmail: read one thread's messages.", parameters: object({ threadId: text("Thread id") }, ["threadId"]) } },
    { type: "function", function: { name: "slack_search_public_and_private", description: "Slack: search messages the person can see: DMs to them, mentions of them and threads they're in. Supports after:YYYY-MM-DD.", parameters: object({ query: text("Slack search query") }, ["query"]) } },
    { type: "function", function: { name: "slack_read_thread", description: "Slack: read a message's thread replies.", parameters: object({ channel_id: text("Channel id"), message_ts: text("Parent message ts") }, ["channel_id", "message_ts"]) } },
    ...(scenario.github?.length ? [
      { type: "function" as const, function: { name: "github_list_notifications", description: "GitHub: the person's notifications (review requests, mentions, assigned issues, security alerts), newest first.", parameters: object({}) } },
      { type: "function" as const, function: { name: "github_get_item", description: "GitHub: read one pull request, issue or security alert with its comments.", parameters: object({ repo: text("owner/name"), number: { type: "number", description: "Number" } }, ["repo", "number"]) } },
    ] : []),
    { type: "function", function: { name: "list_files", description: "List your own scratch files.", parameters: object({}) } },
    { type: "function", function: { name: "read_file", description: "Read one of your own scratch files, such as memory/notes.md.", parameters: object({ path: text("Path") }, ["path"]) } },
    { type: "function", function: { name: "write_file", description: "Write one of your own scratch files, such as memory/notes.md.", parameters: object({ path: text("Path"), content: text("Full content") }, ["path", "content"]) } },
    { type: "function", function: { name: "delete_file", description: "Delete one of your own scratch files.", parameters: object({ path: text("Path") }, ["path"]) } },
    ...extra,
  ];
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw || "{}");
    return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
  } catch {
    return {};
  }
}
const str = (value: unknown) => (typeof value === "string" ? value : "");

function gmailAfter(query: string): number {
  const match = /after:(\S+)/.exec(query)?.[1];
  if (!match) return 0;
  if (/^\d+$/.test(match)) return Number(match) * 1000;
  const date = Date.parse(match.replaceAll("/", "-"));
  return Number.isFinite(date) ? date : 0;
}

/** Answers one read tool at `now`, as Connect would: JSON, only what existed by then. Null for a tool it doesn't know. */
export function answerDayTool(scenario: DayScenario, now: number, files: Map<string, string>, call: ReplayToolCall): string | null {
  const args = parseArgs(call.function.arguments);
  const me = scenario.person.email;
  switch (call.function.name) {
    case "google_calendar_list_events": {
      const from = Date.parse(str(args.timeMin)) || 0;
      const to = Date.parse(str(args.timeMax)) || Number.POSITIVE_INFINITY;
      const items = calendarAt(scenario, now).filter((event) => parsed(event.end) > from && parsed(event.start) < to);
      return JSON.stringify({ timeZone: scenario.timeZone, items: items.map(({ visibleAt: _visible, change: _change, ...event }) => ({ ...event, status: event.status ?? "confirmed" })) });
    }
    case "gmail_search_threads": {
      const query = str(args.query);
      const after = gmailAfter(query);
      const sent = /in:sent|from:me/i.test(query);
      const from = /from:(\S+)/i.exec(query)?.[1]?.toLowerCase();
      const threads = scenario.email.flatMap((thread) => {
        const messages = thread.messages.filter((message) => visible(message.at, now) && parsed(message.at) >= after && (!sent || message.from === me) && (!from || from === "me" || message.from.toLowerCase().includes(from)));
        return messages.length ? [{ id: thread.id, subject: thread.subject, link: thread.link, last: messages.at(-1), messages: messages.length }] : [];
      });
      return JSON.stringify({ threads });
    }
    case "gmail_get_thread": {
      const thread = scenario.email.find((entry) => entry.id === str(args.threadId));
      return JSON.stringify(thread ? { ...thread, messages: thread.messages.filter((message) => visible(message.at, now)) } : { error: "not_found" });
    }
    case "slack_search_public_and_private": {
      const after = (() => {
        const match = /after:(\d{4}-\d{2}-\d{2})/.exec(str(args.query))?.[1];
        return match ? Date.parse(`${match}T00:00:00Z`) : 0;
      })();
      const messages = scenario.chat.filter((message) => visible(message.at, now) && parsed(message.at) >= after);
      // Slack search returns thread replies as messages of their own, pointing at their thread.
      const replies = scenario.chat.flatMap((message) => (message.replies ?? [])
        .filter((reply) => visible(reply.at, now) && parsed(reply.at) >= after)
        .map((reply) => ({ channel: message.channel, channelName: message.channelName, kind: "thread", from: reply.from, at: reply.at, text: reply.text, thread_ts: message.ts, permalink: `${message.permalink}?thread_ts=${message.ts}&reply=${Date.parse(reply.at)}` })));
      return JSON.stringify({ messages: [...messages.map(({ replies: threaded, ...message }) => ({ ...message, reply_count: (threaded ?? []).filter((reply) => visible(reply.at, now)).length })), ...replies] });
    }
    case "slack_read_thread": {
      const parent = scenario.chat.find((message) => message.channel === str(args.channel_id) && message.ts === str(args.message_ts) && visible(message.at, now));
      return JSON.stringify(parent ? { messages: [{ from: parent.from, at: parent.at, text: parent.text }, ...(parent.replies ?? []).filter((reply) => visible(reply.at, now))] } : { error: "not_found" });
    }
    case "github_list_notifications": {
      const items = (scenario.github ?? []).filter((item) => visible(item.at, now));
      return JSON.stringify({ notifications: items.map((item) => ({ id: item.id, repo: item.repo, type: item.type, number: item.number, title: item.title, url: item.url, reason: item.reason, updated_at: [item.at, ...(item.comments ?? []).filter((comment) => visible(comment.at, now)).map((comment) => comment.at)].at(-1) })) });
    }
    case "github_get_item": {
      const item = (scenario.github ?? []).find((entry) => entry.repo === str(args.repo) && entry.number === Number(args.number) && visible(entry.at, now));
      return JSON.stringify(item ? { ...item, comments: (item.comments ?? []).filter((comment) => visible(comment.at, now)) } : { error: "not_found" });
    }
    case "list_files":
      return JSON.stringify({ files: [...files.keys()].sort() });
    case "read_file": {
      const content = files.get(str(args.path));
      return content === undefined ? JSON.stringify({ error: "not_found" }) : content;
    }
    case "write_file":
      files.set(str(args.path), str(args.content));
      return JSON.stringify({ ok: true });
    case "delete_file":
      return JSON.stringify({ ok: files.delete(str(args.path)) });
    default:
      return null;
  }
}

/** The runner shows every memory/ file at the start of each turn; the evals do the same (runner.ts memorySection). */
export function memorySection(files: ReadonlyMap<string, string>): string {
  const memory = [...files.entries()].filter(([path]) => path.startsWith("memory/")).sort(([a], [b]) => a.localeCompare(b));
  if (!memory.length) return "";
  return ["# Your memory (files under memory/)", ...memory.map(([path, content]) => `## ${path}\n${content.trim() || "(empty)"}`)].join("\n\n");
}
