export type DiscussionMessage = {
  role: string;
  text: string;
};

const MAX_CONTEXT_MESSAGES = 8;
const MAX_CONTEXT_CHARACTERS = 6_000;
const MAX_MESSAGE_CHARACTERS = 700;

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function discussionTitle(name: string): string {
  const normalized = oneLine(name) || "Coworker";
  return `Discussion with ${normalized}`.slice(0, 120);
}

export function assignmentTitle(outcome: string): string {
  const normalized = oneLine(outcome);
  if (!normalized) return "New assignment";
  return normalized.length > 80 ? `${normalized.slice(0, 79)}…` : normalized;
}

/**
 * Turn an explicit outcome into a native OpenWork assignment while carrying
 * only visible discussion prose. Reasoning traces and tool payloads never
 * become prompt context, and both message count and total size stay bounded.
 */
export function assignmentPrompt(outcome: string, messages: ReadonlyArray<DiscussionMessage>): string {
  const normalizedOutcome = outcome.trim();
  const context = messages
    .filter((message) => (message.role === "user" || message.role === "assistant") && message.text.trim())
    .slice(-MAX_CONTEXT_MESSAGES)
    .map((message) => {
      const speaker = message.role === "user" ? "You" : "Coworker";
      return `${speaker}: ${message.text.trim().slice(0, MAX_MESSAGE_CHARACTERS)}`;
    })
    .join("\n\n")
    .slice(0, MAX_CONTEXT_CHARACTERS);

  return [
    "This is an explicit assignment created from our ongoing discussion.",
    "",
    "## Outcome",
    "",
    normalizedOutcome,
    ...(context
      ? ["", "## Relevant discussion", "", context]
      : []),
    "",
    "Own this outcome end to end. Keep the discussion context, but treat the outcome above as the source of truth.",
  ].join("\n");
}

export type AssignmentBrief = {
  outcome: string;
  /** The visible discussion carried along, in order; `you` is the person, `coworker` the coworker. */
  context: Array<{ speaker: "you" | "coworker"; text: string }>;
};

const ASSIGNMENT_OPENER = "This is an explicit assignment created from our ongoing discussion.";
const ASSIGNMENT_CLOSER = "Own this outcome end to end. Keep the discussion context, but treat the outcome above as the source of truth.";

/**
 * Read back a message built by `assignmentPrompt` so the transcript can show
 * a person the outcome and the carried discussion instead of the scaffolding
 * the model needs. Anything else returns null and renders as an ordinary message.
 */
export function parseAssignmentBrief(text: string): AssignmentBrief | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(ASSIGNMENT_OPENER)) return null;
  const outcomeStart = trimmed.indexOf("## Outcome");
  if (outcomeStart < 0) return null;
  let body = trimmed.slice(outcomeStart + "## Outcome".length);
  if (body.trimEnd().endsWith(ASSIGNMENT_CLOSER)) body = body.trimEnd().slice(0, -ASSIGNMENT_CLOSER.length);
  const contextStart = body.indexOf("## Relevant discussion");
  const outcome = (contextStart >= 0 ? body.slice(0, contextStart) : body).trim();
  if (!outcome) return null;
  const context: AssignmentBrief["context"] = [];
  if (contextStart >= 0) {
    const raw = body.slice(contextStart + "## Relevant discussion".length).trim();
    const pattern = /^(You|Coworker): /gm;
    const starts: Array<{ index: number; speaker: "you" | "coworker"; length: number }> = [];
    for (const match of raw.matchAll(pattern)) {
      starts.push({ index: match.index ?? 0, speaker: match[1] === "You" ? "you" : "coworker", length: match[0].length });
    }
    starts.forEach((start, position) => {
      const end = position + 1 < starts.length ? starts[position + 1]?.index ?? raw.length : raw.length;
      const line = raw.slice(start.index + start.length, end).trim();
      if (line) context.push({ speaker: start.speaker, text: line });
    });
  }
  return { outcome, context };
}

const MAX_EXPLAIN_SUMMARY_CHARACTERS = 1_200;

/**
 * Ask the coworker, in its own discussion, to explain one responsibility run.
 * The run happened in a separate native thread, so its result and any error
 * travel inside the message; the person still sends it explicitly.
 */
export function explainRunPrompt(input: {
  responsibilityName: string;
  outcome: string;
  when: string;
  summary: string;
  error: string;
}): string {
  const name = oneLine(input.responsibilityName) || "this responsibility";
  const summary = input.summary.trim().slice(0, MAX_EXPLAIN_SUMMARY_CHARACTERS);
  const error = oneLine(input.error);
  return [
    `Explain the ${input.when} run of your responsibility "${name}". It ${input.outcome.toLowerCase()}.`,
    ...(summary ? ["", "Here is what you reported at the end of that run:", "", summary] : []),
    ...(error ? ["", `It stopped with this problem: ${error}`] : []),
    "",
    "Tell me what happened, what the outcome means, and whether anything needs my attention or a change to the responsibility.",
  ].join("\n");
}

/** Messages more than this far apart get a small centered time label between them. */
export const TIME_LABEL_GAP_MS = 20 * 60_000;

/**
 * The time label to show above a message, or null when it follows the previous one closely.
 * Today and yesterday are named; the rest of the week uses the weekday; older dates the date.
 */
export function timeLabelBetween(previous: number | null | undefined, current: number | null | undefined, now = Date.now()): string | null {
  if (!current) return null;
  if (previous && current - previous < TIME_LABEL_GAP_MS) return null;
  const date = new Date(current);
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) return `Today ${time}`;
  if (date.toDateString() === new Date(now - 86_400_000).toDateString()) return `Yesterday ${time}`;
  const withinWeek = now - current < 6 * 86_400_000;
  return `${date.toLocaleDateString(undefined, withinWeek ? { weekday: "long" } : { month: "short", day: "numeric" })} ${time}`;
}
