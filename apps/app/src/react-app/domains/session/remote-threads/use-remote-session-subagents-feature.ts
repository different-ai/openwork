import { useEffect } from "react"
import { useOrgFeature } from "@/react-app/domains/cloud/use-org-feature"
import { setComputerTasksFollowedInChat } from "../surface/composer/computer-mentions"
import { useRemoteThreadStore } from "./remote-thread-store"

/**
 * Reads `remoteSessionSubagents` and `remoteSessionThreadView` for the active
 * organization. Tasks on other computers need a signed-in organization, so
 * signed out, unreachable or missing means off: the chat shows the plain tool
 * call as before and nothing is followed. The first shows a task's progress
 * row; the second also lets the row open its conversation.
 */
export function useRemoteSessionSubagentsFeature(): void {
  const followedInChat = useRemoteThreadStore((state) => state.enabled)
  const enabled = useOrgFeature("remoteSessionSubagents")
  const threadView = useOrgFeature("remoteSessionThreadView")
  useEffect(() => {
    useRemoteThreadStore.getState().setEnabled(enabled)
  }, [enabled])
  useEffect(() => {
    useRemoteThreadStore.getState().setThreadView(threadView)
  }, [threadView])
  useEffect(() => {
    setComputerTasksFollowedInChat(followedInChat)
  }, [followedInChat])
}
