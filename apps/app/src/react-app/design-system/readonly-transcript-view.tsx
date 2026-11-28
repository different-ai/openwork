import { useCallback, type ComponentProps } from "react"
import type { UIMessage } from "ai"

import { UntrustedMarkdown } from "@/components/markdown/untrusted-markdown"
import { MessageList } from "@/components/chat/message-list"
import { MessageListProvider } from "@/components/chat/message-list-provider"
import type { ChatToolReconnectResult } from "@/components/tools/error-attribution"
import { OpenTargetProvider } from "@/lib/target-provider"

export function RemoteTranscriptView({
  threadKey,
  messages,
  running,
  showThinking,
  developerMode,
  assistantBubbles = false,
  connectorIdentities,
  waiting = false,
  runStartedAt = null,
}: {
  threadKey: string
  messages: UIMessage[]
  running: boolean
  showThinking: boolean
  developerMode: boolean
  assistantBubbles?: boolean
  connectorIdentities?: ComponentProps<typeof MessageListProvider>["connectorIdentities"]
  waiting?: boolean
  runStartedAt?: number | null
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
      assistantBubbles={assistantBubbles}
      connectorIdentities={connectorIdentities}
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
        <OpenTargetProvider>
          <MessageList
            messages={messages}
            status={running || waiting ? "streaming" : "ready"}
            activityStatus={waiting ? "waiting" : running ? "thinking" : "idle"}
            fallbackRunStartedAt={runStartedAt}
          />
        </OpenTargetProvider>
      </UntrustedMarkdown>
    </MessageListProvider>
  )
}
