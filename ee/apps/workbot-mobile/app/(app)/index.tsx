import { WorkbotChatProvider } from "@openwork-ee/workbot-client/hooks"
import { ChatScreen } from "../../src/chat/screen"
import { useMe } from "../../src/me"

/** The person's main chat: their one ongoing conversation with Workbot. */
export default function MainChat() {
  const me = useMe()
  return (
    <WorkbotChatProvider value={null}>
      <ChatScreen me={me} chat={null} />
    </WorkbotChatProvider>
  )
}
