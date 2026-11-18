import { t } from "@/i18n"
import { ComposerSendButton } from "../surface/composer/composer-send-button"

/**
 * The follow-up box for a task on another computer, in the chat composer's
 * shape (DESIGN.md T5): one round send/stop button and the computer as a
 * quiet text pill. Enter sends, Shift+Enter adds a line. While the task runs
 * the button stops it and Enter still sends a follow-up, like the chat.
 */
export function RemoteFollowUpComposer({
  draft,
  onDraftChange,
  onSend,
  onStop,
  computer,
  running,
  disabled,
  sending,
  stopping,
  error,
  autoFocus = false,
}: {
  draft: string
  onDraftChange: (draft: string) => void
  onSend: () => void
  onStop: () => void
  /** Where the task runs, shown as a plain pill. */
  computer: string
  running: boolean
  /** No session yet: nothing to follow up on. */
  disabled: boolean
  sending: boolean
  stopping: boolean
  error: string | null
  /** Focus the box on open, where the person just chose to open the task. */
  autoFocus?: boolean
}) {
  const canSend = !disabled && !sending && Boolean(draft.trim())
  // Same as the chat composer: while busy the one button stops, Enter still sends.
  const showStop = running

  return (
    <form
      className="shrink-0 px-3 pb-3 pt-1"
      data-remote-follow-up-composer=""
      onSubmit={(event) => {
        event.preventDefault()
        if (canSend) onSend()
      }}
    >
      <div className="@container/composer relative rounded-[18px] border border-dls-border bg-dls-surface">
        <textarea
          value={draft}
          rows={1}
          disabled={disabled}
          autoFocus={autoFocus}
          aria-label={t("session.remote_task_follow_up")}
          placeholder={t("session.remote_task_follow_up")}
          className="block field-sizing-content max-h-40 min-h-6 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-sm leading-6 text-dls-text outline-none placeholder:text-dls-secondary disabled:cursor-not-allowed disabled:opacity-60"
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return
            event.preventDefault()
            if (canSend) onSend()
          }}
        />
        <div className="flex items-center gap-2 px-3 pb-2">
          <span className="min-w-0 truncate rounded-md px-1.5 text-[12px] font-medium text-gray-10" data-remote-follow-up-computer="">
            {computer}
          </span>
          <div className="ml-auto flex shrink-0 items-center">
            <ComposerSendButton
              mode={stopping ? "stopping" : showStop ? "stop" : sending ? "preparing" : "send"}
              ready={canSend}
              disabled={stopping || (showStop ? disabled : !canSend)}
              onClick={showStop ? onStop : canSend ? onSend : undefined}
              label={stopping
                ? t("session.remote_task_stopping_short")
                : showStop
                  ? t("session.remote_task_stop_short")
                  : t("session.remote_task_send")}
            />
          </div>
        </div>
      </div>
      {error ? <p className="px-2 pt-1 text-xs text-red-11" role="alert">{error}</p> : null}
    </form>
  )
}
