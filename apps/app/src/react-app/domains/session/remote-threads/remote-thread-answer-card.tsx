import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import type { RemoteSessionAnswerInput, RemoteSessionPending } from "@openwork/types/automations"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { t } from "@/i18n"
import { questionAnswer, questionAnswerReady } from "@/lib/remote-session-answers"
import { cn } from "@/lib/utils"

/**
 * The question or permission a task on another computer waits on, answered
 * where the person already is: above the panel's follow-up box (DESIGN.md T4).
 * Text only, no icons; everything from the other computer is plain text.
 * Number keys choose, Enter advances, ⌘Enter allows a permission once.
 */

type Failure = { code: string; message: string; retryable: boolean }
export type RemoteAnswerSubmit = (answer: RemoteSessionAnswerInput) => Promise<Failure | null>

export function RemoteThreadAnswerCard({ pending, computer, onAnswer }: { pending: RemoteSessionPending; computer: string; onAnswer: RemoteAnswerSubmit }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [answered, setAnswered] = useState<string | null>(null)
  const last = useRef<RemoteSessionAnswerInput | null>(null)

  async function submit(answer: RemoteSessionAnswerInput) {
    last.current = answer
    setBusy(true)
    setError(null)
    const failure = await onAnswer(answer)
    setBusy(false)
    if (failure) setError(failure.message)
    else setAnswered(answer.requestId)
  }

  // Once answered it stays hidden until the task waits on something new.
  if (answered === pending.requestId) return null

  const footerError = error ? (
    <div className="flex items-center gap-2 text-xs text-red-11" role="alert" data-remote-answer-error="">
      <span className="min-w-0 flex-1">{t("session.remote_answer_failed", { reason: error })}</span>
      {last.current ? (
        <Button variant="ghost" size="xs" disabled={busy} onClick={() => { if (last.current) void submit(last.current) }}>
          {t("session.remote_task_retry")}
        </Button>
      ) : null}
    </div>
  ) : null

  return pending.kind === "permission"
    ? <PermissionCard key={pending.requestId} pending={pending} computer={computer} busy={busy} error={footerError} onSubmit={submit} />
    : <QuestionCard key={pending.requestId} pending={pending} computer={computer} busy={busy} error={footerError} onSubmit={submit} />
}

type CardProps<Kind extends RemoteSessionPending["kind"]> = {
  pending: Extract<RemoteSessionPending, { kind: Kind }>
  computer: string
  busy: boolean
  error: ReactNode
  onSubmit: (answer: RemoteSessionAnswerInput) => Promise<void>
}

const CARD = "flex shrink-0 flex-col gap-2 border-t border-border bg-background px-3 py-3 outline-none"

function Label({ children }: { children: ReactNode }) {
  return <span className="text-xs text-muted-foreground">{children}</span>
}

function Chord({ children }: { children: ReactNode }) {
  return <span className="text-xs text-muted-foreground">{children}</span>
}

function typing(event: KeyboardEvent) {
  return event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement
}

function PermissionCard({ pending, computer, busy, error, onSubmit }: CardProps<"permission">) {
  const decide = (decision: "once" | "reject") => { if (!busy) void onSubmit({ kind: "permission", requestId: pending.requestId, decision }) }
  return (
    <div
      className={CARD}
      data-remote-answer="permission"
      role="group"
      aria-label={t("session.remote_answer_permission_on", { computer })}
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault()
          decide("once")
        }
      }}
    >
      <Label>{t("session.remote_answer_permission_on", { computer })}</Label>
      <span className="text-sm font-medium text-foreground">{pending.title}</span>
      {pending.detail ? <span className="text-sm text-muted-foreground">{pending.detail}</span> : null}
      {pending.command ? (
        <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-[var(--radius)] bg-muted px-2.5 py-2 font-mono text-xs text-foreground">{pending.command}</pre>
      ) : null}
      {error}
      <div className="flex items-center gap-2">
        <Chord>{t("session.remote_answer_allow_chord")}</Chord>
        <span className="flex-1" />
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => decide("reject")}>{t("session.remote_answer_deny")}</Button>
        <Button size="sm" disabled={busy} onClick={() => decide("once")}>{t("session.remote_answer_allow_once")}</Button>
      </div>
    </div>
  )
}

function QuestionCard({ pending, computer, busy, error, onSubmit }: CardProps<"question">) {
  const [index, setIndex] = useState(0)
  const [answers, setAnswers] = useState<string[][]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [custom, setCustom] = useState("")
  const question = pending.questions[index]
  const total = pending.questions.length
  useEffect(() => {
    setSelected([])
    setCustom("")
  }, [index])
  if (!question) return null
  const answer = questionAnswer(selected, custom, question.custom)
  const ready = questionAnswerReady(question, answer)
  const lastQuestion = index === total - 1

  const choose = (label: string) => {
    if (busy) return
    setSelected((current) => question.multiple
      ? current.includes(label) ? current.filter((item) => item !== label) : [...current, label]
      : [label])
    if (!question.multiple) setCustom("")
  }
  const next = () => {
    if (!ready || busy) return
    const all = [...answers.slice(0, index), answer]
    if (lastQuestion) {
      void onSubmit({ kind: "question", requestId: pending.requestId, answers: all })
      return
    }
    setAnswers(all)
    setIndex(index + 1)
  }

  return (
    <div
      className={CARD}
      data-remote-answer="question"
      role="group"
      aria-label={t("session.remote_answer_question_on", { computer })}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
          event.preventDefault()
          next()
          return
        }
        if (typing(event) || event.metaKey || event.ctrlKey || event.altKey) return
        const number = Number.parseInt(event.key, 10)
        const option = Number.isInteger(number) && number >= 1 ? question.options[number - 1] : undefined
        if (option) {
          event.preventDefault()
          choose(option.label)
        }
      }}
    >
      <Label>
        {total > 1
          ? t("question_modal.question_counter", { current: index + 1, total })
          : t("session.remote_answer_question_on", { computer })}
      </Label>
      <span className="text-sm font-medium text-foreground">{question.question || question.header}</span>
      {question.header && question.question && question.header !== question.question
        ? <span className="text-sm text-muted-foreground">{question.header}</span>
        : null}
      {question.options.length > 0 ? (
        <div className="flex flex-col" role={question.multiple ? "group" : "radiogroup"}>
          {question.options.map((option, position) => {
            const isSelected = selected.includes(option.label)
            return (
              <button
                key={`${position}:${option.label}`}
                type="button"
                role={question.multiple ? "checkbox" : "radio"}
                aria-checked={isSelected}
                aria-label={option.label}
                disabled={busy}
                data-remote-answer-option={option.label}
                className={cn(
                  "flex w-full items-baseline gap-2.5 rounded-[var(--radius)] px-2 py-1.5 text-start text-sm transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none disabled:opacity-60",
                  isSelected && "bg-muted",
                )}
                onClick={() => choose(option.label)}
              >
                <span className="w-3 shrink-0 text-xs tabular-nums text-muted-foreground">{position + 1}</span>
                <span className="flex min-w-0 flex-col">
                  <span className={cn("text-foreground", isSelected && "font-medium")}>{option.label}</span>
                  {option.description && option.description !== option.label
                    ? <span className="text-xs text-muted-foreground">{option.description}</span>
                    : null}
                </span>
              </button>
            )
          })}
        </div>
      ) : null}
      {question.custom ? (
        <Input
          value={custom}
          disabled={busy}
          aria-label={t("session.remote_answer_other")}
          placeholder={t("session.remote_answer_other")}
          className="h-8 text-sm"
          onChange={(event) => {
            setCustom(event.target.value)
            if (!question.multiple && event.target.value.trim()) setSelected([])
          }}
        />
      ) : null}
      {error}
      <div className="flex items-center gap-2">
        <Chord>{t(question.options.length > 1 ? "session.remote_answer_choose_chord" : "session.remote_answer_next_chord", { count: Math.min(question.options.length, 9) })}</Chord>
        <span className="flex-1" />
        <Button size="sm" disabled={!ready || busy} onClick={next}>
          {t(lastQuestion ? "session.remote_answer_send" : "session.remote_answer_next")}
        </Button>
      </div>
    </div>
  )
}
