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
