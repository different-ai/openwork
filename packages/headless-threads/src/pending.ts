import { z } from "zod";

import type { HeadlessThreadAnswer, HeadlessThreadPending } from "./types.js";

/**
 * Pending questions and permissions, read from the engine's own request lists
 * and mapped to plain text the person decides on: v1 lists questions and
 * permissions per workspace, v2 per session, with questions as forms answered
 * by field key and option value. Bounds match the remote-session wire.
 */

const QUESTIONS_MAX = 10;
const OPTIONS_MAX = 50;

const optionSchema = z.object({ label: z.string().min(1), value: z.string().optional(), description: z.string().optional() }).passthrough();
const v1QuestionSchema = z.object({
  id: z.string().min(1),
  sessionID: z.string().optional(),
  questions: z.array(z.object({
    header: z.string().optional(),
    question: z.string().optional(),
    options: z.array(optionSchema).optional(),
    multiple: z.boolean().optional(),
    custom: z.boolean().optional(),
  }).passthrough()).min(1),
}).passthrough();
const v2FormSchema = z.object({
  id: z.string().min(1),
  sessionID: z.string().optional(),
  fields: z.array(z.object({
    key: z.string(),
    type: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
    options: z.array(optionSchema.extend({ value: z.string() })).optional(),
    custom: z.boolean().optional(),
  }).passthrough()).min(1),
}).passthrough();
const permissionSchema = z.object({
  id: z.string().min(1),
  sessionID: z.string().optional(),
  // v1 names the tool `permission` with `patterns`; v2 `action` with `resources`.
  permission: z.string().optional(),
  patterns: z.array(z.string()).optional(),
  action: z.string().optional(),
  resources: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

/** A pending v2 question form: how each answer maps back to its field. */
export type PendingFormField = { key: string; multiple: boolean; values: Map<string, string> };
export type PendingRead = { pending: HeadlessThreadPending | null; fields: PendingFormField[] };

const PERMISSION_TITLES: Record<string, string> = {
  bash: "Run a command", edit: "Edit files", write: "Write files", read: "Read files", webfetch: "Fetch a web page",
  websearch: "Search the web", external_directory: "Use a folder outside the workspace", task: "Start a helper",
  doom_loop: "Keep repeating the same step",
};

function words(value: string): string {
  const spaced = value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_\-.]+/g, " ").trim().toLowerCase();
  return spaced ? `${spaced[0]?.toUpperCase()}${spaced.slice(1)}` : "Use a tool";
}

function clip(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function options(values: z.infer<typeof optionSchema>[] | undefined) {
  return (values ?? []).slice(0, OPTIONS_MAX).map((option) => ({ label: clip(option.label, 240), description: clip(option.description ?? "", 1000) }));
}

export function permissionPending(row: unknown): HeadlessThreadPending | null {
  const parsed = permissionSchema.safeParse(row);
  if (!parsed.success) return null;
  const action = parsed.data.action ?? parsed.data.permission ?? "permission";
  const resources = parsed.data.resources ?? parsed.data.patterns ?? [];
  const metadata = parsed.data.metadata ?? {};
  const described = typeof metadata.description === "string" ? metadata.description.trim() : "";
  const command = typeof metadata.command === "string" && metadata.command.trim() ? metadata.command.trim()
    : action === "bash" && resources[0]?.trim() ? resources[0].trim() : undefined;
  return {
    kind: "permission",
    requestId: clip(parsed.data.id, 240),
    title: clip(PERMISSION_TITLES[action] ?? words(action), 240),
    detail: clip(described || resources.filter((item) => item !== command).join(", "), 2000),
    ...(command ? { command: clip(command, 2000) } : {}),
  };
}

export function v1QuestionPending(row: unknown): HeadlessThreadPending | null {
  const parsed = v1QuestionSchema.safeParse(row);
  if (!parsed.success) return null;
  return {
    kind: "question",
    requestId: clip(parsed.data.id, 240),
    questions: parsed.data.questions.slice(0, QUESTIONS_MAX).map((entry) => ({
      header: clip(entry.header ?? "", 240),
      question: clip(entry.question ?? entry.header ?? "", 2000),
      options: options(entry.options),
      multiple: entry.multiple === true,
      custom: entry.custom !== false,
    })),
  };
}

export function v2FormPending(row: unknown): PendingRead | null {
  const parsed = v2FormSchema.safeParse(row);
  if (!parsed.success) return null;
  const fields = parsed.data.fields.slice(0, QUESTIONS_MAX);
  return {
    pending: {
      kind: "question",
      requestId: clip(parsed.data.id, 240),
      questions: fields.map((field) => ({
        header: clip(field.title ?? "", 240),
        question: clip(field.description ?? field.title ?? "", 2000),
        options: options(field.options),
        multiple: field.type === "multiselect",
        custom: field.custom !== false,
      })),
    },
    fields: fields.map((field) => ({
      key: field.key,
      multiple: field.type === "multiselect",
      values: new Map((field.options ?? []).map((option) => [option.label, option.value])),
    })),
  };
}

/**
 * Why answers don't fit the live question (one answer per question, one choice
 * unless it takes several, free text only where accepted), or null.
 */
export function answerRefusal(pending: Extract<HeadlessThreadPending, { kind: "question" }>, answers: string[][]): string | null {
  if (answers.length !== pending.questions.length) {
    return `Expected ${pending.questions.length} answer${pending.questions.length === 1 ? "" : "s"}, one per question, got ${answers.length}.`;
  }
  for (const [index, question] of pending.questions.entries()) {
    const answer = answers[index] ?? [];
    if (answer.length === 0) return `Question ${index + 1} needs an answer.`;
    if (!question.multiple && answer.length > 1) return `Question ${index + 1} takes one answer.`;
    const labels = new Set(question.options.map((option) => option.label));
    if (answer.some((label) => !labels.has(label)) && !question.custom) {
      return `Question ${index + 1} does not take that answer; choose one of its options.`;
    }
  }
  return null;
}

/** v2 replies by field key and option value; free text passes through as typed. */
export function v2FormAnswer(fields: PendingFormField[], answer: Extract<HeadlessThreadAnswer, { kind: "question" }>): Record<string, string | string[]> {
  return Object.fromEntries(fields.map((field, index) => {
    const values = (answer.answers[index] ?? []).map((label) => field.values.get(label) ?? label);
    return [field.key, field.multiple ? values : values[0] ?? ""];
  }));
}
