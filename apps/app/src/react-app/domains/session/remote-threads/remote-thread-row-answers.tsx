import { useState } from "react"

import { Button } from "@/components/ui/button"
import { t } from "@/i18n"
import { singleChoiceAnswer } from "@/lib/remote-session-answers"
import { answerRemoteThread } from "./remote-thread-actions"
import type { RemoteThreadEntry } from "./remote-thread-store"

/**
 * A single-choice question a task on another computer asks, answered from its
 * row in the chat: each option is one small button. Other answers (free text,
 * option details) are given in the task's conversation, which the last button opens.
 */
export function RemoteThreadRowAnswers({ entry, choices, openPanel }: {
  entry: RemoteThreadEntry
  choices: { requestId: string; options: string[] }
  openPanel: (() => void) | null
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [answered, setAnswered] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (answered === choices.requestId) return null

  async function choose(label: string) {
    setBusy(label)
    setError(null)
    const failure = await answerRemoteThread(entry, singleChoiceAnswer(choices.requestId, label))
    setBusy(null)
    if (failure) setError(failure.message)
    else setAnswered(choices.requestId)
  }

  return (
    <div className="flex min-w-0 flex-col gap-1" data-remote-thread-answers={choices.requestId}>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {choices.options.map((option) => (
          <Button
            key={option}
            variant="outline"
            size="xs"
            className="max-w-full truncate"
            disabled={busy !== null}
            aria-label={t("session.remote_answer_choose", { option })}
            data-remote-thread-answer-option={option}
            onClick={() => void choose(option)}
          >
            {option}
          </Button>
        ))}
        {openPanel ? (
          <Button variant="ghost" size="xs" disabled={busy !== null} onClick={openPanel}>
            {t("session.remote_answer_other_row")}
          </Button>
        ) : null}
      </div>
      {error ? <span className="text-xs text-red-11" role="alert">{t("session.remote_answer_failed", { reason: error })}</span> : null}
    </div>
  )
}
