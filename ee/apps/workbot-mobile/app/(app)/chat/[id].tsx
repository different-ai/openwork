import { CHAT_ID } from "@openwork-ee/workbot-client"
import { WorkbotChatProvider } from "@openwork-ee/workbot-client/hooks"
import { Redirect, useLocalSearchParams } from "expo-router"
import { ChatScreen } from "../../../src/chat/screen"
import { useMe } from "../../../src/me"

/** One of the person's side chats: one topic, next to their main chat, with the same memory. */
export default function SideChat() {
  const me = useMe()
  const { id } = useLocalSearchParams<{ id: string }>()
  if (!me.sideChats || typeof id !== "string" || !CHAT_ID.test(id)) return <Redirect href="/" />
  return (
    <WorkbotChatProvider value={id}>
      <ChatScreen key={id} me={me} chat={id} />
    </WorkbotChatProvider>
  )
}
