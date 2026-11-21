import {
  remoteSessionPendingSchema,
  type RemoteSessionAnswerInput,
  type RemoteSessionPending,
  type RemoteSessionPendingSummary,
} from "@openwork/types/automations"

export function parseRemotePending(value: unknown): RemoteSessionPending | null {
  const parsed = remoteSessionPendingSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

export const ROW_OPTIONS_MAX = 4

export function rowQuestionOptions(pending: RemoteSessionPendingSummary | null | undefined): { requestId: string; options: string[] } | null {
  if (pending?.kind !== "question" || pending.multiple || pending.questionCount !== 1 || pending.options.length === 0) return null
  return { requestId: pending.requestId, options: pending.options.slice(0, ROW_OPTIONS_MAX) }
}

export function singleChoiceAnswer(requestId: string, label: string): RemoteSessionAnswerInput {
  return { kind: "question", requestId, answers: [[label]] }
}

export function questionAnswerReady(question: Extract<RemoteSessionPending, { kind: "question" }>["questions"][number], answer: readonly string[]): boolean {
  if (answer.length === 0) return false
  if (!question.multiple && answer.length > 1) return false
  const labels = new Set(question.options.map((option) => option.label))
  return question.custom || answer.every((label) => labels.has(label))
}

export function questionAnswer(selected: readonly string[], custom: string, allowCustom: boolean): string[] {
  const own = allowCustom ? custom.trim() : ""
  return own ? [...selected, own] : [...selected]
}
