/**
 * Group chats: several coworkers in one conversation with the person.
 *
 * The person writes once; an invisible facilitator decides which coworkers
 * answer (a mention constrains it, `@everyone` includes all, otherwise the best
 * match by role and mission answers alone). Each reply is a real turn in that
 * coworker's own workspace, on a group-specific discussion thread, so it keeps
 * its model, memory, tools, and permissions. Only visible text crosses between
 * coworkers: never reasoning, tool payloads, or another coworker's files.
 */
import type { CoworkerGroupSummary, CoworkerSummary, GroupTimelineEvent } from "./bridge";

export type GroupParticipant = Pick<CoworkerSummary, "slug" | "name" | "role" | "mission">;

/** How many coworkers may answer one message when nobody was named. */
export const MAX_SPEAKERS_PER_TURN = 3;
/** How much of the visible group conversation each speaker is shown. */
export const RECENT_CONTEXT_EVENTS = 12;
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

/** Which participants the person named with `@`, in the order they were named. */
export function parseMentions(text: string, participants: readonly GroupParticipant[]): Mentions {
  const everyone = /(^|\s)@(everyone|all|team)\b/i.test(text);
  const slugs: string[] = [];
  for (const match of text.matchAll(/(^|\s)@([a-z0-9][a-z0-9-]*)/gi)) {
    const handle = (match[2] ?? "").toLowerCase();
    const found = participants.find((participant) => nameTokens(participant).includes(handle));
    if (found && !slugs.includes(found.slug)) slugs.push(found.slug);
  }
  return { everyone, slugs };
}

/**
 * Who should answer. Mentions decide when present; otherwise the coworker whose
 * role and mission best match the message answers alone, with the coworker who
 * spoke last (still on topic) winning ties, then the first participant.
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

function clip(text: string, max = MAX_CONTEXT_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * What one speaker is told for its turn: who is in the room, the recent visible
 * conversation, what earlier speakers in this turn already said, and the message.
 */
export function groupSpeakerPrompt(input: {
  group: Pick<CoworkerGroupSummary, "name">;
  speaker: GroupParticipant;
  participants: readonly GroupParticipant[];
  message: string;
  recent: readonly GroupTimelineEvent[];
  earlierReplies: readonly { name: string; text: string }[];
  nameFor: (slug: string) => string;
}): string {
  const others = input.participants.filter((participant) => participant.slug !== input.speaker.slug);
  const lines = [
    `You are ${input.speaker.name}${input.speaker.role ? `, ${input.speaker.role}` : ""}, in the group chat "${input.group.name}" with the person${others.length ? ` and ${others.map((other) => `${other.name}${other.role ? ` (${other.role})` : ""}`).join(", ")}` : ""}.`,
    "Reply as yourself, in a few sentences, only for your part. Do not speak for anyone else, do not address the other coworkers, and do not repeat what they already said.",
  ];
  const recent = input.recent.filter((event) => event.kind !== "status").slice(-RECENT_CONTEXT_EVENTS);
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

/** One plain line for a group's rail row and header. */
export function describeGroupActivity(events: readonly GroupTimelineEvent[], nameFor: (slug: string) => string): string {
  const latest = [...events].reverse().find((event) => event.kind !== "status");
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

export type SpeakerRunStatus = "queued" | "running" | "succeeded" | "failed" | "stopped";

export type GroupTurnProgress = {
  turnId: string;
  phase: "routing" | "running" | "done";
  speakers: { slug: string; status: SpeakerRunStatus; error?: string }[];
};

export type GroupTurnDeps = {
  /** Sends the prompt to the coworker's group thread and resolves with the reply text. */
  ask: (slug: string, prompt: string, signal: AbortSignal) => Promise<string>;
  append: (event: Omit<GroupTimelineEvent, "id" | "at">) => Promise<GroupTimelineEvent>;
  onProgress?: (progress: GroupTurnProgress) => void;
  now?: () => number;
};

/**
 * Run one group turn: record the message, choose the speakers, and let each
 * answer in order, feeding earlier replies forward. A failure or stop of one
 * speaker is recorded and the others still get their turn; nothing is retried
 * or repeated here.
 */
export async function runGroupTurn(input: {
  group: Pick<CoworkerGroupSummary, "id" | "name">;
  participants: readonly GroupParticipant[];
  recent: readonly GroupTimelineEvent[];
  message: string;
  clientMessageId: string;
  signal: AbortSignal;
  deps: GroupTurnDeps;
}): Promise<GroupTurnProgress> {
  const turnId = `turn_${input.clientMessageId}`;
  const nameFor = (slug: string) => input.participants.find((participant) => participant.slug === slug)?.name ?? slug;
  const progress: GroupTurnProgress = { turnId, phase: "routing", speakers: [] };
  const report = () => input.deps.onProgress?.({ ...progress, speakers: progress.speakers.map((speaker) => ({ ...speaker })) });
  report();
  const userEvent = await input.deps.append({ kind: "user", text: input.message.trim(), turnId, clientMessageId: input.clientMessageId });
  const recent = [...input.recent, userEvent];
  const speakers = chooseSpeakers(input.message, input.participants, input.recent);
  progress.speakers = speakers.map((slug) => ({ slug, status: "queued" }));
  progress.phase = "running";
  report();
  const earlierReplies: { name: string; text: string }[] = [];
  for (const entry of progress.speakers) {
    if (input.signal.aborted) {
      entry.status = "stopped";
      continue;
    }
    const speaker = input.participants.find((participant) => participant.slug === entry.slug);
    if (!speaker) {
      entry.status = "failed";
      entry.error = "That coworker is no longer in the group.";
      continue;
    }
    entry.status = "running";
    report();
    const prompt = groupSpeakerPrompt({ group: input.group, speaker, participants: input.participants, message: input.message, recent: recent.slice(0, -1), earlierReplies, nameFor });
    try {
      const text = await input.deps.ask(speaker.slug, prompt, input.signal);
      if (!text) throw new Error(`${speaker.name} did not reply.`);
      await input.deps.append({ kind: "coworker", slug: speaker.slug, text, turnId });
      earlierReplies.push({ name: speaker.name, text });
      entry.status = "succeeded";
    } catch (cause) {
      entry.status = input.signal.aborted ? "stopped" : "failed";
      entry.error = cause instanceof Error ? cause.message : String(cause);
      await input.deps.append({ kind: "status", slug: speaker.slug, turnId, status: entry.status, text: entry.status === "stopped" ? `${speaker.name} was stopped.` : `${speaker.name} could not reply: ${entry.error}` });
    }
    report();
  }
  progress.phase = "done";
  report();
  return progress;
}
