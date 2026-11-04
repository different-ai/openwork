import { useEffect } from "react"
import { useQuery } from "@tanstack/react-query"

import { markFeatureUsed } from "@/app/lib/den"
import { useOrgFeatureState } from "@/react-app/domains/cloud/use-org-feature"
import { notifyDesktopEvent } from "@/react-app/shell/desktop-notifications"
import { notifyAlert } from "@/react-app/shell/notifications"
import { automationFailureNotices } from "./automation-failure-watch"
import { AUTOMATIONS_SLOW_POLL_MS, useAutomationsDenContext } from "./use-automations"

export const AUTOMATION_FAILURE_NOTIFICATIONS_FEATURE = "automationFailureNotifications"
const WATERMARK_KEY_PREFIX = "openwork.automationFailureWatermark.v1:"

function readWatermark(organizationId: string): number | null {
  try {
    const value = Number(window.localStorage.getItem(`${WATERMARK_KEY_PREFIX}${organizationId}`))
    return Number.isFinite(value) && value > 0 ? value : null
  } catch {
    return null
  }
}

function clearWatermark(organizationId: string) {
  try {
    window.localStorage.removeItem(`${WATERMARK_KEY_PREFIX}${organizationId}`)
  } catch {
    // Nothing to clear without storage.
  }
}

function writeWatermark(organizationId: string, watermark: number) {
  try {
    window.localStorage.setItem(`${WATERMARK_KEY_PREFIX}${organizationId}`, String(watermark))
  } catch {
    // Without storage a restart may announce a failure again; nothing else breaks.
  }
}

/**
 * Tells the owner once when one of their Automations fails, wherever they are
 * in the app: an entry in the notification center (with a toast), and a
 * system notification while the app is in the background. Off unless the
 * `automationFailureNotifications` feature is on for the organization.
 */
export function AutomationFailureNotifier() {
  const feature = useOrgFeatureState(AUTOMATION_FAILURE_NOTIFICATIONS_FEATURE)
  const enabled = feature.enabled
  const confirmedOff = feature.resolved && feature.data === false
  const context = useAutomationsDenContext()
  const { client, organizationId } = context

  // Once Den says the feature is off, forget the watermark: turning it back on
  // starts fresh instead of announcing what failed meanwhile. A loading or
  // unreachable flag keeps it, so failures while the app was closed are still announced.
  useEffect(() => {
    if (confirmedOff && organizationId) clearWatermark(organizationId)
  }, [confirmedOff, organizationId])
  // Same key and request as the Automations page's list, so an open page adds no second poll.
  const listQuery = useQuery({
    queryKey: [...context.queryRoot, "list"],
    queryFn: () => client!.listAutomations(organizationId!, { limit: 100 }),
    enabled: enabled && context.ready,
    refetchInterval: AUTOMATIONS_SLOW_POLL_MS,
    refetchIntervalInBackground: true,
  })
  const items = enabled ? listQuery.data?.items : undefined

  useEffect(() => {
    if (!items || !organizationId) return
    // Read storage right before writing so another window's announcement is not repeated.
    const { notices, watermark } = automationFailureNotices(items, readWatermark(organizationId))
    writeWatermark(organizationId, watermark)
    if (notices.length === 0) return
    markFeatureUsed(AUTOMATION_FAILURE_NOTIFICATIONS_FEATURE)
    for (const notice of notices) {
      notifyAlert({ kind: "system", severity: "error", title: notice.title, body: notice.body, dedupeKey: `automation-run:${notice.runId}` })
      notifyDesktopEvent({ type: "automation.failed", title: notice.title, body: notice.body })
    }
  }, [items, organizationId])

  return null
}
