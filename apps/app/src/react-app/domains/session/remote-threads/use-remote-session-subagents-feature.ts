import { useEffect } from "react"
import { useOrgFeature } from "@/react-app/domains/cloud/use-org-feature"
import { setComputerTasksFollowedInChat } from "../surface/composer/computer-mentions"
import { useRemoteThreadStore } from "./remote-thread-store"

/**
 * Reads `remoteSessionSubagents` for the active organization. Tasks on other
 * computers need a signed-in organization, so signed out, unreachable or
 * missing means off: the chat shows the plain tool call as before and nothing
 * is followed.
 */
export function useRemoteSessionSubagentsFeature(): void {
  const followedInChat = useRemoteThreadStore((state) => state.enabled)
  const enabled = useOrgFeature("remoteSessionSubagents")
  useEffect(() => {
    useRemoteThreadStore.getState().setEnabled(enabled)
  }, [enabled])
  useEffect(() => {
    setComputerTasksFollowedInChat(followedInChat)
  }, [followedInChat])
}
