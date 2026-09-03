/**
 * The one line under a coworker's name in the team rail.
 *
 * It says the most useful true thing: what the coworker is doing now, what it
 * needs, what is coming up next, or what it just finished — and when there is
 * nothing to report, a short remark in its own voice instead of an empty
 * "Ready". Raw assignment prompts never leak into it.
 */
import type { Personality } from "./personalities";
import type { CoworkerActivity } from "./threads";

const TITLE_LIMIT = 48;
/** An upcoming responsibility is worth mentioning when it runs within this window. */
export const UPCOMING_WINDOW_MS = 36 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

/** Short remarks a free coworker makes, per personality; a few each so the rail is not static. */
export const FREE_REMARKS: Record<Personality, readonly string[]> = {
  none: ["Ready for an assignment."],
  neutral: ["Ready for the next assignment.", "Free at the moment.", "Nothing in progress."],
  warm: ["Ready whenever you are!", "Happy to take something on.", "Here if you need a hand."],
  calm: ["Ready when you are.", "Nothing pressing. All good.", "Quiet for now."],
  eager: ["Give me something to dig into!", "Ready to go — what's first?", "Warmed up and waiting."],
  playful: ["Bored. Give me something fun.", "Twiddling thumbs. Send work.", "Free as a bird. Clip my wings."],
  dry: ["Idle. Thrilling.", "Nothing on the desk. Suspicious.", "Available, regrettably."],
  blunt: ["Free. What's next?", "No work queued.", "Idle. Assign something."],
  curious: ["Wondering what's next.", "Any leads to follow?", "Open to a new question."],
  thoughtful: ["Taking stock. Ready for more.", "A quiet moment. Ready when needed.", "Thinking ahead."],
  meticulous: ["Desk clear, notes tidy.", "Everything filed. Ready.", "Checklist empty. Ready."],
  detective: ["No open cases.", "Waiting for a new lead.", "Case files closed. For now."],
};

/** How a coworker with a long list describes it; `{n}` is the count. */
export const FULL_LIST_REMARKS: Record<Personality, readonly string[]> = {
  none: ["{n} assignments so far."],
  neutral: ["{n} assignments so far.", "Working through a full list."],
  warm: ["{n} down — happy to keep going!", "Busy, but in a good way."],
  calm: ["{n} done. One thing at a time.", "Full plate, steady pace."],
  eager: ["{n} done and counting!", "Loaded up and loving it."],
  playful: ["{n} things. Send snacks.", "Juggling {n}. Still smiling."],
  dry: ["{n} things. Fine.", "{n} down. Riveting."],
  blunt: ["{n} done. Next.", "{n} assignments. Keep them coming."],
  curious: ["{n} threads pulled so far.", "{n} down, more to learn."],
  thoughtful: ["{n} done, each considered.", "{n} so far; pacing them."],
  meticulous: ["{n} done, each double-checked.", "{n} filed, nothing skipped."],
  detective: ["{n} cases closed.", "{n} trails followed."],
};

/** A list this long deserves a remark about the list rather than the last item. */
export const FULL_LIST_THRESHOLD = 4;

function hashSeed(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

/** Pick a remark that stays the same for the day, but differs per coworker and per day. */
export function pickRemark(remarks: readonly string[], seed: string, now: number): string {
  if (remarks.length === 0) return "";
  // The local calendar day, so the remark changes overnight rather than at a UTC boundary.
  const day = new Date(now).toDateString();
  return remarks[hashSeed(`${seed}:${day}`) % remarks.length] ?? "";
}

/**
 * A thread title as a short label: the first sentence, without list markers or
 * trailing punctuation, cut to a readable length. Assignment prompts often start
 * with the whole brief, so only the opening clause survives.
 */
export function cleanTitle(title: string): string {
  const flat = title.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const firstSentence = flat.split(/(?<=[.!?])\s+|\s+\d+[).]\s+|\s+[-–—•]\s+/)[0] ?? flat;
  const trimmed = firstSentence.replace(/[.:;,\s]+$/, "");
  if (trimmed.length <= TITLE_LIMIT) return trimmed;
  const cut = trimmed.slice(0, TITLE_LIMIT + 1);
  const atWord = cut.lastIndexOf(" ");
  return `${(atWord > TITLE_LIMIT / 2 ? cut.slice(0, atWord) : cut.slice(0, TITLE_LIMIT)).replace(/[.:;,\s]+$/, "")}…`;
}

/** "in 20 min", "in 3 hr", "tomorrow 9:00 AM", or a time today. */
export function describeUpcoming(at: number, now: number): string {
  const diff = at - now;
  if (diff <= 60_000) return "any moment";
  if (diff < 60 * 60_000) return `in ${Math.round(diff / 60_000)} min`;
  const date = new Date(at);
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) return diff < 6 * 60 * 60_000 ? `in ${Math.round(diff / (60 * 60_000))} hr` : `at ${time}`;
  if (date.toDateString() === new Date(now + DAY_MS).toDateString()) return `tomorrow ${time}`;
  return `${date.toLocaleDateString(undefined, { weekday: "long" })} ${time}`;
}

export type RailLineInput = {
  activity: CoworkerActivity | undefined;
  personality: Personality;
  /** Identifies the coworker so two with the same personality do not speak in unison. */
  seed: string;
  now?: number;
};

/** The line under the coworker's name. */
export function describeRailLine({ activity, personality, seed, now = Date.now() }: RailLineInput): string {
  if (!activity) return "Checking current activity…";
  switch (activity.state) {
    case "starting":
      return "Getting ready…";
    case "offline":
      return activity.detail || "Not answering right now.";
    case "attention":
      return activity.detail || "Needs you.";
    case "retrying":
      return activity.detail ? `Retrying ${cleanTitle(activity.detail)}` : "Retrying.";
    case "working":
      return activity.detail ? `Working on ${lowerFirst(cleanTitle(activity.detail))}` : "Working.";
    default:
      break;
  }
  // Idle: what is next matters more than what was last.
  if (activity.next && activity.next.at - now <= UPCOMING_WINDOW_MS) {
    return `Next: ${cleanTitle(activity.next.name)} · ${describeUpcoming(activity.next.at, now)}`;
  }
  const done = activity.recent?.length ?? 0;
  if (done >= FULL_LIST_THRESHOLD) return pickRemark(FULL_LIST_REMARKS[personality], seed, now).replace("{n}", String(done));
  if (activity.state === "recent" && activity.last?.title) return `Finished ${lowerFirst(cleanTitle(activity.last.title))}`;
  return pickRemark(FREE_REMARKS[personality], seed, now);
}

function lowerFirst(text: string): string {
  // Keep acronyms and proper nouns; only a leading capital of an ordinary word steps down.
  return /^[A-Z][a-z]/.test(text) ? `${text[0]?.toLowerCase() ?? ""}${text.slice(1)}` : text;
}
