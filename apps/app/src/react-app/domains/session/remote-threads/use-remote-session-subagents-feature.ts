import { useEffect } from "react"
import { useOrgFeature } from "@/react-app/domains/cloud/use-org-feature"
import { useRemoteThreadStore } from "./remote-thread-store"

/** Controls the remaining rollout for opening remote tasks in the main pane. */
export function useRemoteSessionSubagentsFeature(): void {
  const helperView = useOrgFeature("remoteSessionHelperView")
  useEffect(() => {
    useRemoteThreadStore.getState().setHelperView(helperView)
  }, [helperView])
}
