import { useEffect } from "react"
import { useOrgFeature } from "@/react-app/domains/cloud/use-org-feature"
import { setComputerTasksFollowedInChat } from "../surface/composer/computer-mentions"
import { useRemoteThreadStore } from "./remote-thread-store"

/**
 * Reads `remoteSessionSubagents` and `remoteSessionThreadView` for the active
 * organization. Tasks on other computers need a signed-in organization, so
 * signed out, unreachable or missing means off: the chat shows the plain tool
 * call as before and nothing is followed. The first shows a task's progress
 * row; the second also lets the row open its conversation; the third opens
 * it in the main pane like a helper instead of beside the chat. With
 * `remoteSessionAnswers` the person answers its question or permission here.
 */
export function useRemoteSessionSubagentsFeature(): void {
  const followedInChat = useRemoteThreadStore((state) => state.enabled)
  const enabled = useOrgFeature("remoteSessionSubagents")
  const threadView = useOrgFeature("remoteSessionThreadView")
  const helperView = useOrgFeature("remoteSessionHelperView")
  const answers = useOrgFeature("remoteSessionAnswers")
  useEffect(() => {
    useRemoteThreadStore.getState().setEnabled(enabled)
  }, [enabled])
  useEffect(() => {
    useRemoteThreadStore.getState().setThreadView(threadView)
  }, [threadView])
  useEffect(() => {
    useRemoteThreadStore.getState().setHelperView(helperView)
  }, [helperView])
  useEffect(() => {
    useRemoteThreadStore.getState().setAnswers(answers)
  }, [answers])
  useEffect(() => {
    setComputerTasksFollowedInChat(followedInChat)
  }, [followedInChat])
}
