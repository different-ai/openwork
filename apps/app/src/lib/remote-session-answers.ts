import {
  remoteSessionPendingSchema,
  type RemoteSessionAnswerInput,
  type RemoteSessionPending,
  type RemoteSessionPendingSummary,
} from "@openwork/types/automations"

/**
 * What a task on another computer waits on the person for, and their answer.
 * Text from the other computer is shown as plain text only: never as links,
 * markdown or anything that runs.
 */

/** The pending request in a Den read, or null when there is none or it doesn't parse. */
export function parseRemotePending(value: unknown): RemoteSessionPending | null {
  const parsed = remoteSessionPendingSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** Options a parent row can offer as buttons: one single-choice question with a few options. */
export const ROW_OPTIONS_MAX = 4

export function rowQuestionOptions(pending: RemoteSessionPendingSummary | null | undefined): { requestId: string; options: string[] } | null {
  if (pending?.kind !== "question" || pending.multiple || pending.questionCount !== 1 || pending.options.length === 0) return null
  return { requestId: pending.requestId, options: pending.options.slice(0, ROW_OPTIONS_MAX) }
}

/** One choice for the row's single question. */
export function singleChoiceAnswer(requestId: string, label: string): RemoteSessionAnswerInput {
  return { kind: "question", requestId, answers: [[label]] }
}

/** Whether one question has an answer that fits it; the card only advances then. */
export function questionAnswerReady(question: Extract<RemoteSessionPending, { kind: "question" }>["questions"][number], answer: readonly string[]): boolean {
  if (answer.length === 0) return false
  if (!question.multiple && answer.length > 1) return false
  const labels = new Set(question.options.map((option) => option.label))
  return question.custom || answer.every((label) => labels.has(label))
}

/** The answers for every question: the chosen labels, plus the person's own words where allowed. */
export function questionAnswer(selected: readonly string[], custom: string, allowCustom: boolean): string[] {
  const own = allowCustom ? custom.trim() : ""
  return own ? [...selected, own] : [...selected]
}
