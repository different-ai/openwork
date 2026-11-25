import { useRef, useState } from "react"
import type { RemoteSessionAnswerInput, RemoteSessionPending } from "@openwork/types/automations"

import { Button } from "@/components/ui/button"
import { t } from "@/i18n"
import { PermissionApprovalPanel } from "../chat/permission-approval-modal"
import { QuestionPanel } from "../modals/question-modal"
import { answerRemoteThread } from "./remote-thread-actions"
import type { RemoteThreadEntry } from "./remote-thread-store"
import type { useRemoteThreadConversation } from "./use-remote-thread-conversation"

type Failure = { code: string; message: string; retryable: boolean }
export type RemoteAnswerSubmit = (answer: RemoteSessionAnswerInput) => Promise<Failure | null>

type Conversation = ReturnType<typeof useRemoteThreadConversation>

export function RemoteThreadAnswerSlot({ entry, conversation }: { entry: RemoteThreadEntry; conversation: Conversation }) {
  const { view, page } = conversation
  if (!view.waitingFor) return null
  const pending = page?.pending
  const summary = entry.status?.pending
  return (
    <div className="mx-auto w-full max-w-3xl shrink-0" data-remote-session-question-slot="">
      {pending?.kind === view.waitingFor && (!summary || (pending.kind === summary.kind && pending.requestId === summary.requestId)) ? (
        <RemoteThreadAnswerCard
          key={`${entry.start.key}:${pending.kind}:${pending.requestId}`}
          pending={pending}
          computer={view.computer}
          onAnswer={(answer) => answerRemoteThread(entry, answer)}
        />
      ) : (
        <div className="border-t border-border px-4 py-2 text-xs text-muted-foreground" data-remote-thread-waiting={view.waitingFor}>
          {t("session.remote_task_answer_there", { computer: view.computer })}
        </div>
      )}
    </div>
  )
}

export function RemoteThreadAnswerCard({ pending, computer, onAnswer }: {
  pending: RemoteSessionPending
  computer: string
  onAnswer: RemoteAnswerSubmit
}) {
  const [attempt, setAttempt] = useState<{
    answer: RemoteSessionAnswerInput
    failure?: Failure
    delivered?: boolean
  } | null>(null)
  const submitting = useRef(false)
  const current = attempt?.answer.requestId === pending.requestId ? attempt : null
  const busy = Boolean(current && !current.failure)
  const blocked = busy || current?.failure?.retryable === false
  if (current?.delivered) return null

  async function submit(answer: RemoteSessionAnswerInput) {
    if (submitting.current || blocked) return
    submitting.current = true
    setAttempt({ answer })
    try {
      const failure = await onAnswer(answer)
      setAttempt(failure ? { answer, failure } : { answer, delivered: true })
    } finally {
      submitting.current = false
    }
  }

  const decide = (decision: "once" | "reject") => void submit({ kind: "permission", requestId: pending.requestId, decision })
  return (
    <div
      data-remote-answer={pending.kind}
      role="group"
      aria-label={t(pending.kind === "permission" ? "session.remote_answer_permission_on" : "session.remote_answer_question_on", { computer })}
      onKeyDown={(event) => {
        if (pending.kind !== "permission" || event.repeat || event.nativeEvent.isComposing || event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return
        event.preventDefault()
        decide("once")
      }}
    >
      {pending.kind === "permission" ? (
        <PermissionApprovalPanel remotePermission={pending} computer={computer} busy={blocked} onDecision={decide} />
      ) : (
        <>
          <p className="px-4 pt-2 text-xs text-muted-foreground">{t("session.remote_answer_question_on", { computer })}</p>
          <QuestionPanel
            key={pending.requestId}
            requestId={`remote:${pending.requestId}`}
            questions={pending.questions}
            busy={blocked}
            variant="composer"
            onReply={(answers) => submit({ kind: "question", requestId: pending.requestId, answers })}
          />
        </>
      )}
      {current?.failure ? (
        <div className="flex items-center gap-2 px-4 py-2 text-xs text-red-11" role="alert" data-remote-answer-error="">
          <span className="min-w-0 flex-1">{t("session.remote_answer_failed", { reason: current.failure.message })}</span>
          {current.failure.retryable ? (
            <Button variant="ghost" size="xs" onClick={() => void submit(current.answer)}>{t("session.remote_task_retry")}</Button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
