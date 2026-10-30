import { useEffect } from "react"
import { useLiveReplyModelStore } from "@/components/chat/live-reply-model-store"
import { useOrgFeature } from "@/react-app/domains/cloud/use-org-feature"

/**
 * Reads `liveReplyModel` for the active organization. Signed out, unreachable
 * or missing means off: the model shows only once a reply has finished.
 */
export function useLiveReplyModelFeature(): void {
  const enabled = useOrgFeature("liveReplyModel")
  useEffect(() => {
    useLiveReplyModelStore.getState().setEnabled(enabled)
  }, [enabled])
}
