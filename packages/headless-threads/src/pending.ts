import { z } from "zod";

import type { HeadlessThreadAnswer, HeadlessThreadPending } from "./types.js";

/**
 * Pending questions and permissions, read from the engine's own request lists
 * and mapped to plain text the person decides on: v1 lists questions and
 * permissions per workspace, v2 per session, with questions as forms answered
 * by field key, each value in the field's own type. Bounds match the remote-session wire.
 */

const QUESTIONS_MAX = 10;
const OPTIONS_MAX = 50;
/** Open requests listed at once; the rest follow as these are answered. */
export const HEADLESS_THREAD_PENDING_ITEMS_MAX = 5;

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
// Only what every form has is required: an unexpected extra never hides a form the thread waits on.
const v2FormSchema = z.object({
  id: z.string().min(1),
  sessionID: z.string().optional(),
  title: z.string().optional(),
  fields: z.array(z.object({
    key: z.string(),
    type: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
    options: z.array(optionSchema.extend({ value: z.string() })).optional(),
    custom: z.boolean().optional(),
    hidden: z.unknown().optional(),
    default: z.unknown().optional(),
    minimum: z.unknown().optional(),
    maximum: z.unknown().optional(),
    when: z.unknown().optional(),
  }).passthrough()).min(1),
}).passthrough();
const v2WhenSchema = z.array(z.object({ key: z.string(), op: z.enum(["eq", "neq"]), value: z.union([z.string(), z.number(), z.boolean()]) }).passthrough());
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

/** A value a v2 form field takes: text or an option's value, a number, yes or no, or several option values. */
export type FormValue = string | number | boolean | string[];
/** A pending v2 form: how each answer maps back to its field, in the order the questions are asked. */
export type PendingFormField = {
  key: string;
  /** How the person's words become the field's value. */
  type: "text" | "boolean" | "number" | "integer";
  multiple: boolean;
  values: Map<string, string>;
  minimum?: number;
  maximum?: number;
  /** The field applies only while every condition holds for the answers before it. */
  when: Array<{ key: string; equal: boolean; value: string | number | boolean }>;
};
export type PendingForm = {
  fields: PendingFormField[];
  /** Fields that are not asked and take their default. */
  preset: Record<string, FormValue>;
  /** False for a form that has a step no remote surface can take, such as opening a link. */
  answerable: boolean;
};
export type PendingRead = PendingForm & { pending: HeadlessThreadPending | null };
/** A request with nothing to map back: a permission, or a v1 question answered by its labels. */
export const PLAIN_FORM: PendingForm = { fields: [], preset: {}, answerable: true };

const YES = "Yes";
const NO = "No";

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

function isFormValue(value: unknown): value is FormValue {
  return typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))
    || (Array.isArray(value) && value.every((item) => typeof item === "string"));
}

/**
 * A v2 form as questions. Yes/no fields offer Yes and No, number fields take
 * a typed number, hidden fields keep their default and are not asked. A field
 * that applies only after certain answers is asked too; its answer is left
 * out when it does not apply. A form with a link to open is reported, so the
 * thread shows what it waits on, but takes no answer from here.
 */
export function v2FormPending(row: unknown): PendingRead | null {
  const parsed = v2FormSchema.safeParse(row);
  if (!parsed.success) return null;
  const requestId = clip(parsed.data.id, 240);
  const preset: Record<string, FormValue> = {};
  const asked = [];
  let external: (typeof parsed.data.fields)[number] | undefined;
  for (const field of parsed.data.fields) {
    if (field.type === "external") external ??= field;
    else if (field.hidden !== true) asked.push(field);
    else if (isFormValue(field.default)) preset[field.key] = field.default;
  }
  if (external || asked.length === 0) {
    const title = external?.title ?? parsed.data.title ?? "";
    return {
      pending: {
        kind: "question",
        requestId,
        questions: [{
          header: clip(title, 240),
          question: external ? "This step opens a link, so it can't be answered from here." : "This step can't be answered from here.",
          options: [],
          multiple: false,
          custom: false,
        }],
      },
      fields: [],
      preset: {},
      answerable: false,
    };
  }
  const fields = asked.slice(0, QUESTIONS_MAX);
  return {
    pending: {
      kind: "question",
      requestId,
      questions: fields.map((field) => ({
        header: clip(field.title ?? "", 240),
        question: clip(field.description ?? field.title ?? "", 2000),
        options: field.type === "boolean" ? [{ label: YES, description: "" }, { label: NO, description: "" }] : options(field.options),
        multiple: field.type === "multiselect",
        custom: field.type === "boolean" ? false : field.type === "number" || field.type === "integer" ? true : field.custom !== false,
      })),
    },
    fields: fields.map((field) => {
      const when = v2WhenSchema.safeParse(field.when);
      return {
        key: field.key,
        type: field.type === "boolean" || field.type === "number" || field.type === "integer" ? field.type : "text",
        multiple: field.type === "multiselect",
        values: new Map((field.options ?? []).map((option) => [option.label, option.value])),
        ...(typeof field.minimum === "number" ? { minimum: field.minimum } : {}),
        ...(typeof field.maximum === "number" ? { maximum: field.maximum } : {}),
        when: when.success ? when.data.map((condition) => ({ key: condition.key, equal: condition.op === "eq", value: condition.value })) : [],
      };
    }),
    preset,
    answerable: true,
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

/** The engine's own rule: a field with conditions applies only while each holds for the answers before it. */
function applies(field: PendingFormField, values: Record<string, FormValue>): boolean {
  return field.when.every((condition) => {
    const value = values[condition.key];
    if (value === undefined) return false;
    const matches = Array.isArray(value) ? value.includes(String(condition.value)) : value === condition.value;
    return condition.equal ? matches : !matches;
  });
}

/**
 * v2 replies by field key, each value in the field's own type: an option's
 * value, free text as typed, a number, yes or no. Returns the refusal message
 * instead when a typed number does not fit its field.
 */
export function v2FormAnswer(form: Pick<PendingForm, "fields" | "preset">, answer: Extract<HeadlessThreadAnswer, { kind: "question" }>): Record<string, FormValue> | string {
  const values: Record<string, FormValue> = { ...form.preset };
  for (const [index, field] of form.fields.entries()) {
    if (!applies(field, values)) continue;
    const given = answer.answers[index] ?? [];
    if (field.type === "boolean") {
      values[field.key] = given[0] === YES;
    } else if (field.type === "number" || field.type === "integer") {
      const number = Number(given[0]?.trim() || Number.NaN);
      if (!Number.isFinite(number)) return `Question ${index + 1} takes a number.`;
      if (field.type === "integer" && !Number.isInteger(number)) return `Question ${index + 1} takes a whole number.`;
      if (field.minimum !== undefined && number < field.minimum) return `Question ${index + 1} must be at least ${field.minimum}.`;
      if (field.maximum !== undefined && number > field.maximum) return `Question ${index + 1} must be at most ${field.maximum}.`;
      values[field.key] = number;
    } else {
      const chosen = given.map((label) => field.values.get(label) ?? label);
      values[field.key] = field.multiple ? chosen : chosen[0] ?? "";
    }
  }
  return values;
}
