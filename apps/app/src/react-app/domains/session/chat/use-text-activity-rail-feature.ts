import { useEffect } from "react"

import { useTextActivityRailStore } from "@/components/chat/text-activity-rail-store"
import { useOrgFeature } from "@/react-app/domains/cloud/use-org-feature"

/**
 * Reads `textActivityRail` for the active organization. Signed out,
 * unreachable or missing means off: the chat keeps the previous rail.
 */
export function useTextActivityRailFeature(): void {
  const enabled = useOrgFeature("textActivityRail")
  useEffect(() => {
    useTextActivityRailStore.getState().setEnabled(enabled)
  }, [enabled])
}
