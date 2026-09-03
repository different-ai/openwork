/**
 * Group chats: several coworkers in one conversation with the person.
 *
 * The person writes once; a silent facilitator decides which coworkers answer
 * and in what order (a mention constrains it, `@everyone` includes all, and
 * without a model the best match by role and mission answers alone). Each
 * reply is a real turn in that coworker's own workspace, on a group-specific
 * discussion thread, so it keeps its model, memory, tools, and permissions.
 * Only visible text crosses between coworkers: never reasoning, tool payloads,
 * or another coworker's files. Every turn is a record in the group's store, so
 * the view, a retry, and recovery after a quit all read one source of truth.
 */
import type { CoworkerGroupSummary, CoworkerGroupTurn, CoworkerSummary, GroupSpeakerPart, GroupTimelineEvent, GroupTurnPatch } from "./bridge";
import { describeTurnFailure } from "./turn-failure.ts";

export type GroupParticipant = Pick<CoworkerSummary, "slug" | "name" | "role" | "mission">;

/** How many coworkers may answer one message when nobody was named. */
export const MAX_SPEAKERS_PER_TURN = 3;
/** How much of the visible group conversation each speaker is shown. */
export const RECENT_CONTEXT_EVENTS = 12;
/** What a coworker says when it truly has nothing to contribute; rendered as a quiet line, never a bubble. */
export const NOTHING_TO_ADD = "Nothing to add.";
const MAX_CONTEXT_CHARS = 600;
const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "to", "of", "in", "on", "for", "with", "is", "are", "be", "we", "you", "i", "it",
  "this", "that", "can", "could", "would", "should", "please", "what", "how", "do", "does", "our", "your", "my",
  "me", "us", "at", "by", "from", "about", "as", "if", "so", "not", "let", "lets", "help", "need", "want",
]);

export type Mentions = { everyone: boolean; slugs: string[] };

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9@]+/)
    .map((token) => token.replace(/^@/, ""))
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token));
}

function nameTokens(participant: GroupParticipant): string[] {
  return [participant.slug, ...participant.name.toLowerCase().split(/\s+/).filter(Boolean)];
}

/**
 * Which participants the person named with `@`, in the order they were named.
 * A handle counts at the start, after a space, or after an opening bracket, so
 * an email address is never a mention and trailing punctuation is ignored.
 */
export function parseMentions(text: string, participants: readonly GroupParticipant[]): Mentions {
  const everyone = /(^|[\s(\[])@(everyone|all|team)\b/i.test(text);
  const slugs: string[] = [];
  for (const match of text.matchAll(/(^|[\s(\[])@([a-z0-9][a-z0-9-]*)/gi)) {
    const handle = (match[2] ?? "").toLowerCase().replace(/-+$/, "");
    const found = participants.find((participant) => nameTokens(participant).includes(handle));
    if (found && !slugs.includes(found.slug)) slugs.push(found.slug);
  }
  return { everyone, slugs };
}

/** The member names the composer can offer for a handle being typed, best first. */
export function mentionCandidates(handle: string, participants: readonly GroupParticipant[]): GroupParticipant[] {
  const typed = handle.toLowerCase();
  return participants.filter((participant) => nameTokens(participant).some((token) => token.startsWith(typed)));
}

/**
 * Who should answer without a facilitator model. Mentions decide when present;
 * otherwise the coworker whose role and mission best match the message answers
 * alone, with the coworker who spoke last (still on topic) winning ties, then
 * the first participant.
 */
export function chooseSpeakers(
  text: string,
  participants: readonly GroupParticipant[],
  recent: readonly GroupTimelineEvent[] = [],
): string[] {
  const first = participants[0];
  if (!first) return [];
  const mentions = parseMentions(text, participants);
  if (mentions.everyone) return participants.map((participant) => participant.slug);
  if (mentions.slugs.length > 0) return mentions.slugs.slice(0, Math.max(MAX_SPEAKERS_PER_TURN, mentions.slugs.length));
  const words = new Set(tokens(text));
  const lastSpeaker = [...recent].reverse().find((event) => event.kind === "coworker")?.slug ?? "";
  let best: GroupParticipant = first;
  let bestScore = -1;
  for (const participant of participants) {
    const profile = new Set(tokens(`${participant.role} ${participant.mission}`));
    let score = 0;
    for (const word of words) if (profile.has(word)) score += 1;
    if (participant.slug === lastSpeaker) score += 0.5;
    if (score > bestScore) {
      best = participant;
      bestScore = score;
    }
  }
  return [best.slug];
}

/** A name for a new group from its members' roles, or their names when roles are blank. */
export function suggestGroupName(participants: readonly GroupParticipant[]): string {
  const roles = participants.map((participant) => participant.role.trim()).filter(Boolean);
  if (roles.length >= 2) {
    const heads = roles.map((role) => role.split(/\s+/)[0]).filter((word, index, all) => all.indexOf(word) === index);
    return heads.length > 1 ? `${heads.slice(0, -1).join(", ")} & ${heads.at(-1)}` : `${heads[0]} desk`;
  }
  const names = participants.map((participant) => participant.name.trim()).filter(Boolean);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} & ${names.at(-1)}` : "Group chat";
}

/** "Scout", "Scout and Editor", "Scout, Editor and Ops". */
export function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function clip(text: string, max = MAX_CONTEXT_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** True when a reply is the agreed "nothing to add" signal, however it is punctuated. */
export function isNothingToAdd(text: string): boolean {
  return /^\W*nothing (more |else |new )?to add\W*$/i.test(text.trim());
}

/**
 * What one speaker is told for its turn: who is in the room, the recent visible
 * conversation, what earlier speakers in this turn already said, its own part
 * (the facilitator's brief), and the message. Status lines, reasoning, and tool
 * payloads never appear here.
 */
export function groupSpeakerPrompt(input: {
  group: Pick<CoworkerGroupSummary, "name">;
  speaker: GroupParticipant;
  participants: readonly GroupParticipant[];
  message: string;
  recent: readonly GroupTimelineEvent[];
  earlierReplies: readonly { name: string; text: string }[];
  nameFor: (slug: string) => string;
  /** One sentence from the facilitator on what this coworker should cover. */
  brief?: string;
  part?: GroupSpeakerPart;
}): string {
  const others = input.participants.filter((participant) => participant.slug !== input.speaker.slug);
  const part = input.part ?? "reply";
  const lines = [
    `You are ${input.speaker.name}${input.speaker.role ? `, ${input.speaker.role}` : ""}, in the group chat "${input.group.name}" with the person${others.length ? ` and ${others.map((other) => `${other.name}${other.role ? ` (${other.role})` : ""}`).join(", ")}` : ""}.`,
  ];
  if (part === "wrap-up") {
    lines.push("Your part in this reply: wrap the round up for the person in two or three sentences — what was said, what was agreed, and what happens next. Add no new ideas and do not repeat each reply in turn.");
  } else if (part === "follow-up") {
    lines.push(`Your part in this reply: ${input.brief?.trim() || "respond to what the other coworkers just said — build on it or push back, briefly."}`);
    lines.push("Reply as yourself, in a few sentences. You may address a coworker by name; still write for the person, who is reading.");
  } else {
    lines.push(`Your part in this reply: ${input.brief?.trim() || "answer the person for your part, from your role."}`);
    lines.push("Reply as yourself, in a few sentences, addressing the person. Do not speak for anyone else and do not repeat what the others already said — add something new.");
  }
  lines.push(`If you truly have nothing to contribute, reply with exactly "${NOTHING_TO_ADD}" and nothing else.`);
  const recent = input.recent.filter((event) => event.kind === "user" || event.kind === "coworker").slice(-RECENT_CONTEXT_EVENTS);
  if (recent.length > 0) {
    lines.push("", "Recent group conversation:");
    for (const event of recent) {
      const who = event.kind === "user" ? "Person" : input.nameFor(event.slug ?? "");
      lines.push(`- ${who}: ${clip(event.text)}`);
    }
  }
  if (input.earlierReplies.length > 0) {
    lines.push("", "Already said in reply to this message:");
    for (const reply of input.earlierReplies) lines.push(`- ${reply.name}: ${clip(reply.text)}`);
  }
  lines.push("", `The person's message: ${input.message.trim()}`);
  return lines.join("\n");
}

/** One plain line for a group's rail row: who is replying now, or who spoke last. */
export function describeGroupActivity(
  events: readonly GroupTimelineEvent[],
  nameFor: (slug: string) => string,
  live?: Pick<CoworkerGroupTurn, "status" | "speakers"> | null,
): string {
  if (live && live.status === "routing") return "Choosing who should respond…";
  const speaking = live?.speakers.find((speaker) => speaker.status === "running");
  if (speaking) return `${nameFor(speaking.slug)} is replying…`;
  const latest = [...events].reverse().find((event) => event.kind === "user" || event.kind === "coworker");
  if (!latest) return "No messages yet";
  if (latest.kind === "user") return "Waiting for a reply";
  return `${nameFor(latest.slug ?? "")} replied`;
}

/** Visible text of the assistant messages that arrived after a turn was accepted. */
export function replyTextSince(
  messages: readonly { role: string; parts: readonly { type?: string; text?: string; synthetic?: boolean; ignored?: boolean }[] }[],
  messageCountBefore: number,
): string {
  return messages
    .slice(messageCountBefore)
    .filter((message) => message.role === "assistant")
    .flatMap((message) => message.parts.filter((part) => part.type === "text" && !part.synthetic && !part.ignored).map((part) => part.text ?? ""))
    .join("\n")
    .trim();
}

/**
 * Why a coworker's saved model cannot take this turn, checked before asking so
 * the failure names the model and the fix instead of a provider error. Empty
 * when the model is connected (or none is saved: the engine default runs).
 */
export function unavailableModelReason(model: string, connected: readonly { id: string; providerId: string; providerLabel: string }[]): string {
  const saved = model.trim();
  if (!saved || connected.some((option) => option.id === saved)) return "";
  const providerId = saved.slice(0, Math.max(0, saved.indexOf("/"))) || saved;
  const provider = connected.find((option) => option.providerId === providerId);
  if (provider) return `The saved model "${saved}" is not offered by ${provider.providerLabel} any more. Choose another of its AI models.`;
  return `The saved model "${saved}" is not available: provider "${providerId}" is not connected on this Mac. Choose another AI model or connect that provider in OpenWork.`;
}

/** The plain reason one speaker did not reply, in the vocabulary the 1:1 view uses. */
export function describeSpeakerFailure(raw: string, name: string): { headline: string; modelRelated: boolean } {
  const message = raw.trim();
  if (/took too long/i.test(message)) return { headline: `${name} took too long to reply.`, modelRelated: false };
  if (/^Stopped when the app closed/i.test(message)) return { headline: `${name} was stopped when the app closed.`, modelRelated: false };
  if (/^Stopped\.?$/i.test(message)) return { headline: `${name} was stopped.`, modelRelated: false };
  const failure = describeTurnFailure(message, name);
  return { headline: failure.headline, modelRelated: failure.modelRelated };
}

/** How one message should be answered: who, in what order, and how they relate. */
export type RoutingPlan = {
  speakers: { slug: string; brief: string }[];
  mode: "sequential" | "parallel";
  /** `[later, earlier]`: the later speaker should build on the earlier one's reply. */
  dependsOn: [string, string][];
  /** One coworker responding to another after the first round; never more than one. */
  followUp: { slug: string; brief: string } | null;
  /** A short wrap-up after everyone replied, only when the facilitator asked for one. */
  synthesizer: string | null;
  routedBy: CoworkerGroupTurn["routedBy"];
};

/** The plan without a facilitator model: mentions decide, else the role scorer picks one. */
export function fallbackPlan(text: string, participants: readonly GroupParticipant[], recent: readonly GroupTimelineEvent[]): RoutingPlan {
  const mentions = parseMentions(text, participants);
  return {
    speakers: chooseSpeakers(text, participants, recent).map((slug) => ({ slug, brief: "" })),
    mode: "sequential",
    dependsOn: [],
    followUp: null,
    synthesizer: null,
    routedBy: mentions.everyone || mentions.slugs.length > 0 ? "mentions" : "fallback",
  };
}

/** The speaker list a plan records on the turn: the round, then the follow-up, then the wrap-up. */
export function planSpeakers(plan: RoutingPlan): NonNullable<GroupTurnPatch["speakers"]> {
  const speakers: NonNullable<GroupTurnPatch["speakers"]> = plan.speakers.map((speaker) => ({ slug: speaker.slug, brief: speaker.brief, part: "reply" }));
  if (plan.followUp) speakers.push({ slug: plan.followUp.slug, brief: plan.followUp.brief, part: "follow-up" });
  if (plan.synthesizer) speakers.push({ slug: plan.synthesizer, brief: "", part: "wrap-up" });
  return speakers;
}

export type GroupTurnDeps = {
  /** Sends the prompt to the coworker's group thread and resolves with its visible reply and the thread it ran on. */
  ask: (slug: string, prompt: string, signal: AbortSignal) => Promise<{ text: string; threadId: string }>;
  append: (event: Omit<GroupTimelineEvent, "id" | "at">) => Promise<GroupTimelineEvent>;
  /** Opens the turn record and the person's line; `created` is false when this message already has a turn. */
  begin: (input: { clientMessageId: string; prompt: string }) => Promise<{ turn: CoworkerGroupTurn; created: boolean; userEvent: GroupTimelineEvent | null }>;
  /** Writes one change to the turn record and returns the record as stored. */
  record: (turnId: string, patch: GroupTurnPatch) => Promise<CoworkerGroupTurn>;
  /** The silent facilitator; resolves null when it could not decide, so the fallback plan is used. */
  route?: (input: { message: string; mentions: Mentions; participants: readonly GroupParticipant[]; recent: readonly GroupTimelineEvent[]; signal: AbortSignal }) => Promise<RoutingPlan | null>;
  /** Called with the stored record after every change, so the view renders what is persisted. */
  onTurn?: (turn: CoworkerGroupTurn) => void;
  now?: () => number;
};

type RunContext = {
  group: Pick<CoworkerGroupSummary, "id" | "name">;
  participants: readonly GroupParticipant[];
  /** The visible conversation before this turn's message. */
  recent: readonly GroupTimelineEvent[];
  message: string;
  signal: AbortSignal;
  deps: GroupTurnDeps;
};

function nameLookup(participants: readonly GroupParticipant[]): (slug: string) => string {
  return (slug) => participants.find((participant) => participant.slug === slug)?.name ?? slug;
}

/**
 * Let the unfinished speakers of a turn reply, in order. Each one is persisted
 * as it starts and settles, its bubble is appended the moment its reply
 * arrives, and one failure, timeout, or stop never blocks the next. Speakers
 * that already finished are never asked again.
 */
async function runSpeakers(context: RunContext, turn: CoworkerGroupTurn, earlier: { name: string; text: string }[], only?: string): Promise<CoworkerGroupTurn> {
  const { deps, signal } = context;
  const now = deps.now ?? Date.now;
  const nameFor = nameLookup(context.participants);
  let current = turn;
  const publish = (next: CoworkerGroupTurn) => {
    current = next;
    deps.onTurn?.(next);
    return next;
  };
  const pending = current.speakers.filter((speaker) => speaker.status !== "succeeded" && speaker.status !== "passed" && (!only || speaker.slug === only));
  const parallel = current.mode === "parallel" && pending.every((speaker) => speaker.part === "reply");
  const asks = new Map<string, Promise<{ text: string; threadId: string }>>();
  const promptFor = (speaker: GroupParticipant, part: GroupSpeakerPart, brief: string, replies: readonly { name: string; text: string }[]) =>
    groupSpeakerPrompt({ group: context.group, speaker, participants: context.participants, message: context.message, recent: context.recent, earlierReplies: replies, nameFor, brief, part });
  if (parallel) {
    // Independent replies start together; they still settle into the timeline in the facilitator's order.
    for (const entry of pending) {
      const speaker = context.participants.find((participant) => participant.slug === entry.slug);
      if (!speaker || signal.aborted) continue;
      asks.set(`${entry.slug}:${entry.part}`, deps.ask(speaker.slug, promptFor(speaker, entry.part, entry.brief, earlier), signal));
      publish(await deps.record(current.id, { speaker: { slug: entry.slug, part: entry.part, status: "running", startedAt: now() } }));
    }
  }
  const stoppedNames: string[] = [];
  for (const entry of pending) {
    if (signal.aborted) {
      publish(await deps.record(current.id, { speaker: { slug: entry.slug, part: entry.part, status: "stopped", error: "Stopped.", endedAt: now() } }));
      stoppedNames.push(nameFor(entry.slug));
      continue;
    }
    const speaker = context.participants.find((participant) => participant.slug === entry.slug);
    if (!speaker) {
      publish(await deps.record(current.id, { speaker: { slug: entry.slug, part: entry.part, status: "failed", error: "That coworker is no longer in the group.", endedAt: now() } }));
      continue;
    }
    const key = `${entry.slug}:${entry.part}`;
    const started = asks.get(key);
    if (!started) publish(await deps.record(current.id, { speaker: { slug: entry.slug, part: entry.part, status: "running", startedAt: now(), error: "" } }));
    try {
      const reply = await (started ?? deps.ask(speaker.slug, promptFor(speaker, entry.part, entry.brief, earlier), signal));
      if (!reply.text) throw new Error(`${speaker.name} did not reply.`);
      if (isNothingToAdd(reply.text)) {
        await deps.append({ kind: "status", slug: speaker.slug, turnId: current.id, status: "passed", text: `${speaker.name} had nothing to add.` });
        publish(await deps.record(current.id, { speaker: { slug: entry.slug, part: entry.part, status: "passed", threadId: reply.threadId, endedAt: now() } }));
      } else {
        await deps.append({ kind: "coworker", slug: speaker.slug, text: reply.text, turnId: current.id, threadId: reply.threadId });
        earlier.push({ name: speaker.name, text: reply.text });
        publish(await deps.record(current.id, { speaker: { slug: entry.slug, part: entry.part, status: "succeeded", threadId: reply.threadId, endedAt: now() } }));
      }
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      const status = signal.aborted ? "stopped" : "failed";
      if (status === "failed") await deps.append({ kind: "status", slug: speaker.slug, turnId: current.id, status, text: describeSpeakerFailure(error, speaker.name).headline });
      else stoppedNames.push(speaker.name);
      publish(await deps.record(current.id, { speaker: { slug: entry.slug, part: entry.part, status, error, endedAt: now() } }));
    }
  }
  // One quiet line for the whole stop, whoever was mid-reply and whoever had not started.
  if (stoppedNames.length > 0) await deps.append({ kind: "status", turnId: current.id, status: "stopped", text: `Stopped before ${listNames(stoppedNames)} replied.` });
  return current;
}

/**
 * Run one group turn for a new message: open its record (a double Send finds
 * the turn already open and does nothing), let the facilitator choose who
 * answers, then let them reply in order. Resolves with the stored turn, or
 * null when this message already had one.
 */
export async function runGroupTurn(input: {
  group: Pick<CoworkerGroupSummary, "id" | "name">;
  participants: readonly GroupParticipant[];
  recent: readonly GroupTimelineEvent[];
  message: string;
  clientMessageId: string;
  signal: AbortSignal;
  deps: GroupTurnDeps;
}): Promise<CoworkerGroupTurn | null> {
  const { deps } = input;
  const message = input.message.trim();
  const begun = await deps.begin({ clientMessageId: input.clientMessageId, prompt: message });
  if (!begun.created) return null;
  deps.onTurn?.(begun.turn);
  const mentions = parseMentions(message, input.participants);
  let plan: RoutingPlan | null = null;
  if (deps.route && !input.signal.aborted) {
    plan = await deps.route({ message, mentions, participants: input.participants, recent: input.recent, signal: input.signal }).catch(() => null);
  }
  if (!plan) plan = fallbackPlan(message, input.participants, input.recent);
  const routed = await deps.record(begun.turn.id, { speakers: planSpeakers(plan), mode: plan.dependsOn.length > 0 ? "sequential" : plan.mode, routedBy: plan.routedBy });
  deps.onTurn?.(routed);
  return runSpeakers({ group: input.group, participants: input.participants, recent: input.recent, message, signal: input.signal, deps }, routed, []);
}

/**
 * Finish a turn that was stopped, interrupted by a quit, or partly failed:
 * the unfinished speakers reply with the same message and context, after the
 * replies that already exist. `only` retries one speaker.
 */
export async function resumeGroupTurn(input: {
  group: Pick<CoworkerGroupSummary, "id" | "name">;
  participants: readonly GroupParticipant[];
  turn: CoworkerGroupTurn;
  /** The whole visible timeline; the turn's own message and replies are found in it. */
  events: readonly GroupTimelineEvent[];
  only?: string;
  signal: AbortSignal;
  deps: GroupTurnDeps;
}): Promise<CoworkerGroupTurn> {
  const nameFor = nameLookup(input.participants);
  const userIndex = input.events.findIndex((event) => event.kind === "user" && event.turnId === input.turn.id);
  const recent = userIndex === -1 ? input.events : input.events.slice(0, userIndex);
  const earlier = input.events
    .filter((event) => event.kind === "coworker" && event.turnId === input.turn.id)
    .map((event) => ({ name: nameFor(event.slug ?? ""), text: event.text }));
  const pending = input.turn.speakers.filter((speaker) => speaker.status !== "succeeded" && speaker.status !== "passed" && (!input.only || speaker.slug === input.only));
  if (pending.length === 0) return input.turn;
  // The speakers about to run are queued again so the view shows them in order before the first starts.
  let turn = input.turn;
  for (const speaker of pending) {
    turn = await input.deps.record(turn.id, { speaker: { slug: speaker.slug, part: speaker.part, status: "queued", error: "", endedAt: null } });
  }
  input.deps.onTurn?.(turn);
  return runSpeakers({ group: input.group, participants: input.participants, recent, message: input.turn.prompt, signal: input.signal, deps: input.deps }, turn, earlier, input.only);
}

/** The speakers of a turn that can still be continued or retried. */
export function unfinishedSpeakers(turn: Pick<CoworkerGroupTurn, "speakers">): CoworkerGroupTurn["speakers"] {
  return turn.speakers.filter((speaker) => speaker.status !== "succeeded" && speaker.status !== "passed");
}

/** "Scout is replying… then Editor" — the live row while a turn runs. */
export function describeTurnProgress(turn: Pick<CoworkerGroupTurn, "status" | "speakers">, nameFor: (slug: string) => string): string {
  if (turn.status === "routing") return "Choosing who should respond…";
  const running = turn.speakers.filter((speaker) => speaker.status === "running");
  const queued = turn.speakers.filter((speaker) => speaker.status === "queued");
  if (running.length === 0 && queued.length === 0) return "";
  if (running.length === 0) {
    const [next, ...rest] = queued.map((speaker) => nameFor(speaker.slug));
    return `Starting with ${next}…${rest.length > 0 ? ` then ${listNames(rest)}` : ""}`;
  }
  const first = `${listNames(running.map((speaker) => nameFor(speaker.slug)))} ${running.length > 1 ? "are" : "is"} replying…`;
  const then = queued.length > 0 ? ` then ${listNames(queued.map((speaker) => nameFor(speaker.slug)))}` : "";
  return `${first}${then}`;
}
