// A question the agent asks without stopping its work. The engine's own question tool blocks the turn
// until the person answers; this one returns at once and the answer reaches
// the chat later (see opencode-v2-background-questions.ts).
import { z } from "zod";

export const ASK_WITHOUT_WAITING = "ask_without_waiting";

// The same questions the engine's question tool takes, so the agent can use either.
export const askArgs = z.object({
  questions: z.array(z.object({
    header: z.string().min(1).max(60).describe("A very short label, such as \"Save location\"."),
    question: z.string().min(1).max(1000),
    options: z.array(z.object({ label: z.string().min(1).max(120), description: z.string().max(300).optional() }).strict()).max(8).optional()
      .describe("Choices to pick from. The person can always type their own answer."),
    multiple: z.boolean().optional().describe("true lets the person pick more than one option."),
  }).strict()).min(1).max(4),
}).strict();

// All model-facing guidance for asking lives here.
// How to write a question, for both the engine's question tool and ask_without_waiting.
export const questionWritingGuidance = "Ask only for a decision you cannot make yourself. When the person just has to finish a step, such as approving a sign-in, tell them what to do in a message and wait for or check the result yourself instead of asking whether they are done. Keep a question short: a sentence or a short paragraph that someone can read at a glance. The person sees your chat messages and the question, not tool output or your thinking, so never point at something they cannot see, such as \"the link above\" or \"this plan\": write the link, code or plan in a chat message before you ask.";

export const askDescription = `Ask the person something without stopping. Takes the same questions as the question tool but returns at once: their answer arrives later as a message in this chat, and starts a new turn if yours has ended. Use it when other parts of the task do not depend on the answer, and keep working on those; use question when nothing useful can continue until they answer. Either way, never end your turn on a question written in the chat: ask with one of these tools instead. Do not ask again while a question is open. ${questionWritingGuidance}`;

/** Adds the writing guidance to the engine's own question tool. */
export function questionToolDefinition(input: { toolID: string }, output: { description: string }) {
  if (input.toolID === "question") output.description += `\n\n${questionWritingGuidance}`;
}

export const ASK_FORM = "ask_form";

const formOption = z.object({
  label: z.string().min(1).max(60),
  description: z.string().max(120).optional(),
  icon: z.string().regex(/^[a-z0-9-]{1,40}$/).optional().describe("A Lucide icon name, such as \"smartphone\", \"shield-check\" or \"server\"."),
  tone: z.enum(["default", "warning", "danger", "success"]).optional().describe("warning for cost, danger for risk, success for a safe choice. Leave out otherwise."),
}).strict();

const formField = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("choice"),
    question: z.string().min(1).max(300),
    options: z.array(formOption).min(2).max(8),
    multiple: z.boolean().optional(),
    display: z.enum(["list", "cards", "tiles"]).optional().describe("list for plain rows, cards for options with an icon and a short description, tiles for a small set of visual choices."),
  }).strict(),
  z.object({
    kind: z.literal("scale"),
    question: z.string().min(1).max(300),
    min: z.number().int().min(0).max(100), max: z.number().int().min(1).max(100),
    minLabel: z.string().max(40), maxLabel: z.string().max(40),
  }).strict(),
  z.object({ kind: z.literal("date"), question: z.string().min(1).max(300) }).strict(),
  z.object({ kind: z.literal("text"), question: z.string().min(1).max(300), placeholder: z.string().max(80).optional() }).strict(),
]);

export const askFormArgs = z.object({
  title: z.string().min(1).max(40).describe("What the form is about, such as \"Roadmap details\"."),
  fields: z.array(formField).min(1).max(6),
}).strict();

export type AskFormField = z.infer<typeof formField>;

export const askFormDescription = "Ask the person several things at once in one form shown in the chat: choices (as rows, cards with icons, or tiles), a scale, a date, or free text. Returns at once; their answers arrive later as one message in this chat. Ask only what you cannot work out yourself, and use ask_without_waiting for a single simple question.";

/** The plain questions an older app shows when it cannot draw the form. */
export function formQuestions(form: z.infer<typeof askFormArgs>) {
  return form.fields.map((field) => ({
    header: form.title,
    question: field.kind === "scale" ? `${field.question} (${field.min} = ${field.minLabel}, ${field.max} = ${field.maxLabel})`
      : field.kind === "date" ? `${field.question} (YYYY-MM-DD)` : field.question,
    ...(field.kind === "choice" ? {
      options: field.options.map(({ label, description }) => ({ label, ...(description ? { description } : {}) })),
      ...(field.multiple ? { multiple: true } : {}),
    } : {}),
  }));
}
