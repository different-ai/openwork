import { useCallback, type ReactNode } from "react"
import type { UIMessage } from "ai"

import { UntrustedMarkdown } from "@/components/markdown/untrusted-markdown"
import { MessageList } from "@/components/chat/message-list"
import { MessageListProvider } from "@/components/chat/message-list-provider"
import type { ChatToolReconnectResult } from "@/components/tools/error-attribution"

/**
 * A task on another computer, read through the main chat renderer: the same
 * activity rail, step labels, folded "Worked for…" turns and Technical
 * details as a local chat, whichever rail the chat currently uses.
 *
 * Read only: nothing here edits, branches or reconnects. The ids are the
 * task's own (`remote:<threadKey>`), so no local session, workspace sync or
 * activity record is read or changed for it.
 */
export function RemoteTranscriptView({
  threadKey,
  messages,
  running,
  showThinking,
  developerMode,
  children,
}: {
  threadKey: string
  messages: UIMessage[]
  /** The task is working right now: its latest turn stays open with its Working line. */
  running: boolean
  showThinking: boolean
  developerMode: boolean
  /** Rendered after the transcript, e.g. follow-ups not yet in it. */
  children?: ReactNode
}) {
  const scope = `remote:${threadKey}`
  const noop = useCallback(() => {}, [])
  const reconnect = useCallback(async (): Promise<ChatToolReconnectResult> => {
    throw new Error("Reconnect on the computer that runs this task.")
  }, [])
  const reopen = useCallback(async () => {}, [])
  return (
    <MessageListProvider
      readOnly
      workspaceId={scope}
      sessionId={scope}
      showThinking={showThinking}
      developerMode={developerMode}
      displaySuggestions={false}
      providerConnectedCount={0}
      dispatchAction={noop}
      setPrompt={noop}
      onRevertToUserMessage={noop}
      onEditUserMessage={noop}
      onMcpReconnect={reconnect}
      onMcpReopenAuthorization={reopen}
    >
      {/* Text from the other computer is untrusted: it must not make this
          browser fetch URLs it chose (images, video, raw HTML). */}
      <UntrustedMarkdown>
        <MessageList
          messages={messages}
          status={running ? "streaming" : "ready"}
          activityStatus={running ? "thinking" : "idle"}
        />
        {children}
      </UntrustedMarkdown>
    </MessageListProvider>
  )
}
