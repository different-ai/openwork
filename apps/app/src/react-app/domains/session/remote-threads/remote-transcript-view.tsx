import { useCallback, type ReactNode } from "react"
import type { UIMessage } from "ai"

import { UntrustedMarkdown } from "@/components/markdown/untrusted-markdown"
import { MessageList } from "@/components/chat/message-list"
import { MessageListProvider } from "@/components/chat/message-list-provider"
import type { ChatToolReconnectResult } from "@/components/tools/error-attribution"

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
  running: boolean
  showThinking: boolean
  developerMode: boolean
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
