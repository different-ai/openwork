import {
  AGENT_INSTRUCTIONS,
  AGENT_RESPONSIBILITIES,
  AGENT_TIMING,
  agentLedgerKey,
  agentWakePrompt,
  decideAgentDelivery,
  isMorningPass,
  parseAgentReply,
  projectGoogleCalendarEvents,
  zonedClock,
  zonedInstant,
  type AgentPromptSource,
  type AgentWakeReason,
  type CalendarWake,
  type ProactivePolicy,
} from "../../../packages/automations/src/proactive.ts";
import {
  agentBriefForCheck,
  agentCheckInstructions,
  agentCheckPrompt,
  agentMessageInstructions,
  agentMessagePrompt,
  agentMessageRetryPrompt,
  checkSlotsOn,
  decideBriefDelivery,
  extraChecksLeft,
  isFirstCheckOfDay,
  parseAgentMessages,
  parseCheckReport,
  parseRequestedCheckTime,
  pendingCheckRequests,
  planCheckRequest,
  settleCheckRequests,
  type AgentCheckOccasion,
  type AgentCheckRequest,
  type AgentConversationTurn,
  type AgentRhythm,
} from "../../../packages/automations/src/proactive-brief.ts";
import { DEFAULT_AGENT_BRIEF, EMPTY_AGENT_PREFERENCES } from "../../../packages/types/src/den/workbot-proactive.ts";
import { answerDayTool, calendarAt, dayTools, memorySection, type DayScenario } from "./day.ts";
import type { ReplayMessage, ReplayModel, ReplayToolCall, ReplayToolSpec, ReplayUsage } from "./harness.ts";

/**
 * Two ways of running a recorded day, with the same model, world and read-only tools:
 *
 * - `old`: today's agent. A morning pass, then about every three hours, plus calendar wakes (a meeting with outsiders
 *   15 minutes before, a change someone else made); one turn with AGENT_INSTRUCTIONS and the wake prompt, the JSON
 *   reply, and today's delivery rules (presets, told-once, 3 a day).
 * - `new`: the brief's. A check every 2 hours from 8 AM plus extra checks the agent asks for with request_check; step 1
 *   with the spec's check prompt and the default brief, step 2 only for P0/P1 findings with the member's conversation,
 *   retried once when malformed; Den's limits (decideBriefDelivery, 4 a day).
 *
 * Both keep memory/ across checks (shown at the start of each turn, as the runner does) and start each check with a
 * fresh transcript, so notes are their only memory. Delivered messages go into the member's conversation, with what
 * the member wrote back, at the times they wrote it.
 */

export type Pipeline = "old" | "new";
export type StepUsage = { calls: number } & ReplayUsage;
export type DeliveredMessage = { at: number; text: string };
export type CheckLog = {
  at: number;
  occasion: string;
  answer: string;
  outcome: string;
  delivered: string[];
  tools: string[];
  usage: { check: StepUsage; message: StepUsage };
};
export type DayRun = { scenario: string; pipeline: Pipeline; messages: DeliveredMessage[]; checks: CheckLog[]; error: string | null };

const MAX_STEPS = 20;
const HOUR = 3_600_000;
const zeroUsage = (): StepUsage => ({ calls: 0, input: 0, cached: 0, output: 0 });
function addUsage(total: StepUsage, usage: ReplayUsage | undefined) {
  total.calls += 1;
  total.input += usage?.input ?? 0;
  total.cached += usage?.cached ?? 0;
  total.output += usage?.output ?? 0;
}

/** One turn with tools, answered by the world (and `extra` for tools only one pipeline has). */
async function toolLoop(input: {
  model: ReplayModel;
  system: string;
  user: string;
  tools: readonly ReplayToolSpec[];
  answer: (call: ReplayToolCall) => string;
  usage: StepUsage;
}): Promise<{ text: string; tools: string[] }> {
  const messages: ReplayMessage[] = [{ role: "system", content: input.system }, { role: "user", content: input.user }];
  const called: string[] = [];
  for (let step = 1; step <= MAX_STEPS; step += 1) {
    const reply = await input.model({ messages, tools: input.tools });
    addUsage(input.usage, reply.usage);
    const calls = reply.tool_calls ?? [];
    if (!calls.length) return { text: reply.content ?? "", tools: called };
    messages.push({ role: "assistant", content: reply.content, tool_calls: calls });
    for (const call of calls) {
      called.push(call.function.name);
      messages.push({ role: "tool", tool_call_id: call.id, content: input.answer(call) });
    }
  }
  return { text: "", tools: called };
}

function sourcesFor(scenario: DayScenario, lastReadAt: number | null): AgentPromptSource[] {
  return [
    { id: "calendar", name: "Calendar", via: ["Google Calendar"], instruction: "", lastReadAt },
    { id: "email", name: "Email", via: ["Gmail"], instruction: "", lastReadAt },
    { id: "chat", name: "Team chat", via: ["Slack"], instruction: "", lastReadAt },
    ...(scenario.github?.length ? [{ id: "conn_github", name: "GitHub", via: [], instruction: "", lastReadAt }] : []),
  ];
}

/** "github" is how the model names the GitHub connection; the other sources go by their ids. */
function resolveSource(source: string): string | null {
  const needle = source.trim().toLowerCase();
  const aliases: Record<string, string> = { slack: "chat", gmail: "email", mail: "email", "google calendar": "calendar", github: "conn_github" };
  return aliases[needle] ?? (["calendar", "email", "chat", "conn_github"].includes(needle) ? needle : null);
}

function conversationAt(scenario: DayScenario, sent: readonly DeliveredMessage[], now: number): AgentConversationTurn[] {
  return [
    ...sent.map((message) => ({ at: message.at, from: "agent" as const, text: message.text })),
    ...(scenario.memberSays ?? []).map((entry) => ({ at: Date.parse(entry.at), from: "member" as const, text: entry.text })),
  ].filter((turn) => turn.at <= now && turn.at > now - 2 * 24 * HOUR).sort((a, b) => a.at - b.at);
}

function dayOf(at: number, timeZone: string) {
  return zonedClock(at, timeZone).date;
}

/** An established agent: it last read every source at 6 PM the evening before the first window. */
function previousEvening(scenario: DayScenario): number {
  const [year, month, day] = (scenario.windows[0]?.date ?? "2026-10-21").split("-").map(Number);
  return zonedInstant(scenario.timeZone, year ?? 0, month ?? 0, (day ?? 0) - 1, 18);
}

/** The brief's pipeline over a scenario. */
export async function runNewPipeline(scenario: DayScenario, model: ReplayModel): Promise<DayRun> {
  const run: DayRun = { scenario: scenario.id, pipeline: "new", messages: [], checks: [], error: null };
  const tz = scenario.timeZone;
  const rhythm: AgentRhythm = { policy: { workingDays: "weekdays", startHour: 8, endHour: 19 }, everyHours: 2, quietWindow: null };
  const cap = 4;
  const files = new Map<string, string>(scenario.notes ? [["memory/notes.md", scenario.notes]] : []);
  const told = new Set<string>();
  let requests: AgentCheckRequest[] = [];
  let lastCheckAt: number | null = null;
  const name = scenario.person.first;
  const instructions = agentCheckInstructions({ name, brief: agentBriefForCheck({ name, organization: DEFAULT_AGENT_BRIEF, member: scenario.memberLines ?? "" }) });
  const requestTool: ReplayToolSpec = {
    type: "function",
    function: {
      name: "request_check",
      description: "Your agent's background check only: ask for one extra check at a time today or tomorrow, when timing matters before your next scheduled check (a meeting at 2 PM, a deadline at 5). Den keeps it inside the member's hours, caps extra checks per day and shows the reason in My bot. Asking again for about the same time changes nothing.",
      parameters: { type: "object", properties: { at: { type: "string", description: "When: ISO 8601 with an offset, or a local time today (13:45)." }, why: { type: "string", description: "Why, as the member will read it." } }, required: ["at", "why"], additionalProperties: false },
    },
  };
  try {
    for (const window of scenario.windows) {
      const [year, month, day] = window.date.split("-").map(Number);
      const start = zonedInstant(tz, year ?? 0, month ?? 0, day ?? 0, window.from);
      const end = zonedInstant(tz, year ?? 0, month ?? 0, day ?? 0, window.to);
      const slots = checkSlotsOn(rhythm, { year: year ?? 0, month: month ?? 0, day: day ?? 0 }, tz).filter((at) => at >= start && at < end);
      let cursor = start - 1;
      for (;;) {
        const slot = slots.find((at) => at > cursor);
        const requested = pendingCheckRequests(requests).find((request) => request.at > cursor && request.at < end);
        const now = Math.min(slot ?? Number.POSITIVE_INFINITY, requested?.at ?? Number.POSITIVE_INFINITY);
        if (!Number.isFinite(now)) break;
        cursor = now;
        const occasion: AgentCheckOccasion = isFirstCheckOfDay(rhythm, lastCheckAt, now, tz) ? { kind: "first" } : slot === now || !requested ? { kind: "scheduled" } : { kind: "requested", at: requested.at, why: requested.why };
        const log: CheckLog = { at: now, occasion: occasion.kind, answer: "", outcome: "", delivered: [], tools: [], usage: { check: zeroUsage(), message: zeroUsage() } };
        const nextScheduled = checkSlotsOn(rhythm, zonedClock(now, tz), tz).find((at) => at > now) ?? null;
        const step1 = await toolLoop({
          model,
          system: [instructions, memorySection(files)].filter(Boolean).join("\n\n"),
          user: agentCheckPrompt({ occasion, now, timeZone: tz, nextCheckAt: nextScheduled, extraChecksLeft: extraChecksLeft(requests, 3, now, tz), sources: sourcesFor(scenario, lastCheckAt ?? previousEvening(scenario)) }),
          tools: dayTools(scenario, [requestTool]),
          usage: log.usage.check,
          answer: (call) => {
            if (call.function.name !== "request_check") return answerDayTool(scenario, now, files, call) ?? JSON.stringify({ error: "unknown_tool" });
            const args = JSON.parse(call.function.arguments || "{}");
            const at = parseRequestedCheckTime(String(args.at ?? ""), now, tz);
            if (at === null) return "Give at as ISO 8601 with an offset or a local time today (13:45).";
            const decision = planCheckRequest({ at, why: String(args.why ?? ""), now, timeZone: tz, rhythm, extraChecksPerDay: 3, requests });
            if (decision.kind === "accepted") requests = decision.requests;
            const clock = (value: number) => new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(value);
            return decision.kind === "accepted" ? `Extra check set for ${clock(decision.request.at)} (${decision.usedThatDay} of 3 that day).`
              : decision.kind === "duplicate" ? `Already set for ${clock(decision.request.at)}.`
                : decision.kind === "covered" ? `Your scheduled check at ${clock(decision.slot)} already covers that.` : decision.message;
          },
        });
        log.tools = step1.tools;
        log.answer = step1.text;
        requests = settleCheckRequests(requests, now);
        lastCheckAt = now;
        const report = parseCheckReport(step1.text);
        if (report.kind === "none") log.outcome = "no_findings";
        else {
          const sentToday = run.messages.filter((message) => dayOf(message.at, tz) === dayOf(now, tz)).length;
          if (sentToday >= cap) log.outcome = "daily_limit";
          else {
            const messages: ReplayMessage[] = [
              { role: "system", content: agentMessageInstructions(name) },
              { role: "user", content: agentMessagePrompt({ name, sentToday, cap, now, timeZone: tz, nextCheckAt: nextScheduled, firstCheck: occasion.kind === "first", report: report.report, conversation: conversationAt(scenario, run.messages, now) }) },
            ];
            let reply = await model({ messages, tools: [] });
            addUsage(log.usage.message, reply.usage);
            let parsed = parseAgentMessages(reply.content ?? "");
            if (parsed.kind === "invalid") {
              messages.push({ role: "assistant", content: reply.content ?? "" }, { role: "user", content: agentMessageRetryPrompt(parsed.reason) });
              reply = await model({ messages, tools: [] });
              addUsage(log.usage.message, reply.usage);
              parsed = parseAgentMessages(reply.content ?? "");
            }
            log.answer += `\n\n--- step 2 ---\n${reply.content ?? ""}`;
            if (parsed.kind !== "messages") log.outcome = parsed.kind === "quiet" ? "findings_held" : "unreadable_reply";
            else {
              const decision = decideBriefDelivery({ messages: parsed.messages, sources: new Set(sourcesFor(scenario, null).map((source) => source.id)), resolveSource, told, sentToday, dailyCap: cap, rhythm, snoozedUntil: null, at: now, timeZone: tz });
              if (decision.kind === "held") log.outcome = decision.reason;
              else {
                for (const message of decision.deliver) {
                  for (const entry of message.ledger) told.add(agentLedgerKey(entry.item));
                  run.messages.push({ at: now, text: message.text });
                  log.delivered.push(message.text);
                }
                log.outcome = decision.deliver.length ? "sent" : decision.skipped.some((entry) => entry.reason === "daily_limit") ? "daily_limit" : "already_told";
              }
            }
          }
        }
        run.checks.push(log);
      }
    }
  } catch (error) {
    run.error = error instanceof Error ? error.message : String(error);
  }
  return run;
}

/** Today's wakes in a window: a morning pass, about every three hours, and calendar events that wake it early. */
function legacyWakes(scenario: DayScenario, window: DayScenario["windows"][number], policy: ProactivePolicy): { at: number; scheduled: boolean; calendar: CalendarWake[] }[] {
  const tz = scenario.timeZone;
  const [year, month, day] = window.date.split("-").map(Number);
  const start = zonedInstant(tz, year ?? 0, month ?? 0, day ?? 0, window.from);
  const end = zonedInstant(tz, year ?? 0, month ?? 0, day ?? 0, window.to);
  const wakes = new Map<number, { at: number; scheduled: boolean; calendar: CalendarWake[] }>();
  for (let at = start; at < end; at += AGENT_TIMING.checkEveryMs) wakes.set(at, { at, scheduled: true, calendar: [] });
  // The event as Google's events.list returns it, projected the way Den's event source does.
  const facts = (entry: DayScenario["calendar"][number]) => projectGoogleCalendarEvents({
    timeZone: tz,
    items: [{
      id: entry.id, status: entry.status ?? "confirmed", summary: entry.title, htmlLink: entry.htmlLink, updated: entry.updated, created: entry.visibleAt ?? "2026-10-01T12:00:00Z",
      start: { dateTime: entry.start }, end: { dateTime: entry.end },
      organizer: { email: entry.organizer, self: entry.organizer === scenario.person.email },
      attendees: entry.attendees,
    }],
  }, scenario.person.email).events[0];
  for (const entry of scenario.calendar) {
    const shown = calendarAt(scenario, end).find((event) => event.id === entry.id);
    // A meeting with people from outside the company, 15 minutes before it starts (the default lead time).
    const outside = entry.attendees.some((attendee) => !attendee.self && !attendee.email.endsWith("@acme.example"));
    const soon = Date.parse(entry.start) - 15 * 60_000;
    const event = facts(entry);
    if (outside && shown === entry && entry.status !== "cancelled" && soon >= start && soon < end && event) {
      const at = Math.ceil(soon / (5 * 60_000)) * 5 * 60_000;
      const wake = wakes.get(at) ?? { at, scheduled: false, calendar: [] };
      wake.calendar.push({ kind: "meeting_soon", ref: `${entry.id}:${Date.parse(entry.start)}`, event });
      wakes.set(at, wake);
    }
    // A change someone else made, seen at the next five-minute look.
    if (entry.change && entry.visibleAt && event) {
      const seen = Math.ceil(Date.parse(entry.visibleAt) / (5 * 60_000)) * 5 * 60_000;
      if (seen >= start && seen < end) {
        const wake = wakes.get(seen) ?? { at: seen, scheduled: false, calendar: [] };
        const ref = `${entry.id}:${entry.updated}`;
        if (entry.change.kind === "moved") wake.calendar.push({ kind: "calendar_change", ref, change: "moved", event, previousStart: entry.change.previousStart ? Date.parse(entry.change.previousStart) : null });
        else wake.calendar.push({ kind: "calendar_change", ref, change: entry.change.kind, event });
        wakes.set(seen, wake);
      }
    }
  }
  return [...wakes.values()].filter((wake) => policy.startHour <= zonedClock(wake.at, tz).hour).sort((a, b) => a.at - b.at);
}

/** Today's pipeline over a scenario. */
export async function runOldPipeline(scenario: DayScenario, model: ReplayModel): Promise<DayRun> {
  const run: DayRun = { scenario: scenario.id, pipeline: "old", messages: [], checks: [], error: null };
  const tz = scenario.timeZone;
  const policy: ProactivePolicy = { workingDays: "weekdays", startHour: 8, endHour: 19, dailyCap: 3 };
  const files = new Map<string, string>(scenario.notes ? [["memory/notes.md", scenario.notes]] : []);
  const told = new Set<string>();
  let lastPassAt: number | null = null;
  const words = { ...EMPTY_AGENT_PREFERENCES, ...scenario.memberWords };
  const sourceIds = new Set(sourcesFor(scenario, null).map((source) => source.id));
  try {
    for (const window of scenario.windows) {
      for (const wake of legacyWakes(scenario, window, policy)) {
        const now = wake.at;
        const morning = wake.scheduled && isMorningPass(policy, lastPassAt, now, tz);
        const reasons: AgentWakeReason[] = [
          ...(wake.scheduled ? [{ kind: "scheduled" as const, morning }] : []),
          ...wake.calendar.map((calendarWake) => ({ kind: "calendar" as const, wake: calendarWake })),
        ];
        const log: CheckLog = { at: now, occasion: morning ? "morning" : wake.scheduled ? "scheduled" : "calendar", answer: "", outcome: "", delivered: [], tools: [], usage: { check: zeroUsage(), message: zeroUsage() } };
        const step = await toolLoop({
          model,
          system: [AGENT_INSTRUCTIONS, memorySection(files)].filter(Boolean).join("\n\n"),
          user: agentWakePrompt({ reasons, sources: sourcesFor(scenario, lastPassAt ?? previousEvening(scenario)), responsibilities: [...AGENT_RESPONSIBILITIES], instructions: "", now, timeZone: tz, wishes: { preferences: words, quietWindow: null } }),
          tools: dayTools(scenario),
          usage: log.usage.check,
          answer: (call) => answerDayTool(scenario, now, files, call) ?? JSON.stringify({ error: "unknown_tool" }),
        });
        log.tools = step.tools;
        log.answer = step.text;
        if (wake.scheduled) lastPassAt = now;
        const reply = parseAgentReply(step.text);
        if (reply.kind !== "message") log.outcome = reply.kind === "quiet" ? "quiet" : "unreadable_reply";
        else {
          const items = reply.items.map((item) => ({ ...item, source: resolveSource(item.source) ?? item.source }));
          const sentToday = run.messages.filter((message) => dayOf(message.at, tz) === dayOf(now, tz)).length;
          const decision = decideAgentDelivery({ items, sources: sourceIds, enabled: new Set(AGENT_RESPONSIBILITIES), muted: new Set(), told, sentToday, policy, at: now, timeZone: tz, snoozedUntil: null });
          if (decision.kind === "deliver") {
            for (const item of decision.items) told.add(agentLedgerKey(item));
            run.messages.push({ at: now, text: reply.message });
            log.delivered.push(reply.message);
            log.outcome = "sent";
          } else {
            if (decision.reason === "daily_limit") for (const item of decision.items) told.add(agentLedgerKey(item));
            log.outcome = decision.reason;
          }
        }
        run.checks.push(log);
      }
    }
  } catch (error) {
    run.error = error instanceof Error ? error.message : String(error);
  }
  return run;
}
