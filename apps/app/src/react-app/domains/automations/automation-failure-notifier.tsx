import { useEffect } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "react-router"

import { markFeatureUsed } from "@/app/lib/den"
import { isDesktopRuntime } from "@/app/lib/runtime-env"
import { toast } from "@/components/ui/sonner"
import { useOrgFeatureState } from "@/react-app/domains/cloud/use-org-feature"
import { notifyDesktopEvent } from "@/react-app/shell/desktop-notifications"
import { notifyAlert, notifyEvent } from "@/react-app/shell/notifications"
import { automationsRoute } from "@/react-app/shell/workspace-routes"
import { useDesktopAutomationsEnabled } from "./automation-availability"
import { dispatchAutomationsStateChanged } from "./automation-events"
import { automationFailureNotices, missedRunBody, missedRunOffer, type AutomationFailureNotice } from "./automation-failure-watch"
import { automationCloudRunAvailable } from "./automation-placement"
import { AUTOMATIONS_SLOW_POLL_MS, describeAutomationError, useAutomationsDenContext } from "./use-automations"

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
 * Tells the owner once when one of their Automations fails or misses a run,
 * wherever they are in the app: an entry in the notification center (with a
 * toast), and a system notification while the app is in the background. A
 * missed run's toast stays until answered and offers to run it now or to move
 * its schedule to the cloud. Off unless the `automationFailureNotifications`
 * feature is on for the organization.
 */
export function AutomationFailureNotifier() {
  const feature = useOrgFeatureState(AUTOMATION_FAILURE_NOTIFICATIONS_FEATURE)
  const enabled = feature.enabled
  const confirmedOff = feature.resolved && feature.data === false
  const context = useAutomationsDenContext()
  const { client, organizationId, queryRoot } = context
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  // This app is one of the desktops a Desktop Automation runs on, unless the organization turned those off.
  const desktopAutomationsEnabled = useDesktopAutomationsEnabled()
  const onDesktop = isDesktopRuntime() && desktopAutomationsEnabled

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
    if (!items || !organizationId || !client) return
    // Read storage right before writing so another window's announcement is not repeated.
    const { notices, watermark } = automationFailureNotices(items, readWatermark(organizationId))
    writeWatermark(organizationId, watermark)
    if (notices.length === 0) return
    markFeatureUsed(AUTOMATION_FAILURE_NOTIFICATIONS_FEATURE)

    const open = (automationId: string, runId?: string) => navigate(
      `${automationsRoute()}?${new URLSearchParams({ automation: automationId, ...(runId ? { run: runId } : {}) })}`,
    )
    const failed = (error: unknown, automationId: string) => toast.error(describeAutomationError(error), {
      action: { label: "Open", onClick: () => open(automationId) },
    })
    const refresh = async () => {
      await queryClient.invalidateQueries({ queryKey: queryRoot })
      dispatchAutomationsStateChanged()
    }
    /** `inCloud` runs this one occurrence in the cloud; otherwise it runs where the Automation does. */
    const runNow = async (notice: AutomationFailureNotice, inCloud: boolean, queued: string) => {
      try {
        const run = await client.runAutomationNow(organizationId, notice.automationId, inCloud ? { executionTarget: "cloud" } : {})
        await refresh()
        toast.success(queued, { action: { label: "View", onClick: () => open(notice.automationId, run.id) } })
      } catch (error) {
        failed(error, notice.automationId)
      }
    }
    const moveToCloud = async (notice: AutomationFailureNotice) => {
      try {
        await client.updateAutomation(organizationId, notice.automationId, { executionTarget: "cloud" })
        await refresh()
        // Moving keeps the schedule; the run that was missed is still one click away.
        toast.success(`${notice.name} now runs in the cloud`, {
          description: "Its next runs start there, even when your desktop is offline.",
          action: { label: "Run now", onClick: () => void runNow(notice, false, `${notice.name} queued in the cloud`) },
        })
      } catch (error) {
        failed(error, notice.automationId)
      }
    }
    const announceMissed = (notice: AutomationFailureNotice, desktopRunsAhead: boolean, cloudAvailable: boolean) => {
      const offer = missedRunOffer({ desktopRunsAhead, onDesktop, cloudAvailable })
      const body = missedRunBody(notice.body, offer)
      notifyEvent({ kind: "system", severity: "warning", title: notice.title, body, dedupeKey: `automation-run:${notice.runId}` })
      notifyDesktopEvent({ type: "automation.missed", title: notice.title, body })
      const inCloud = offer.run === "cloud"
      toast.warning(notice.title, {
        id: `automation-missed:${notice.runId}`,
        description: body,
        // A choice to make, not news: it waits for an answer instead of timing out.
        duration: Infinity,
        action: offer.run
          ? { label: inCloud ? "Run in cloud" : "Run now", onClick: () => void runNow(notice, inCloud, inCloud ? `${notice.name} queued in the cloud` : `${notice.name} queued`) }
          : { label: "Open", onClick: () => open(notice.automationId, notice.runId) },
        cancel: offer.moveToCloud ? { label: "Move to cloud", onClick: () => void moveToCloud(notice) } : undefined,
      })
    }

    for (const notice of notices) {
      if (notice.missed) continue
      notifyAlert({ kind: "system", severity: "error", title: notice.title, body: notice.body, dedupeKey: `automation-run:${notice.runId}` })
      notifyDesktopEvent({ type: "automation.failed", title: notice.title, body: notice.body })
    }
    const missed = notices.flatMap((notice) => notice.missed ? [{ notice, desktopRunsAhead: notice.missed.desktopRunsAhead }] : [])
    if (missed.length === 0) return
    // Whether the cloud can take the run is asked only now, with the same request the editor shares.
    void queryClient.fetchQuery({
      queryKey: [...queryRoot, "execution-targets"],
      queryFn: () => client.listAutomationRunners(organizationId),
      staleTime: AUTOMATIONS_SLOW_POLL_MS,
    }).then(automationCloudRunAvailable, () => false).then((cloudAvailable) => {
      for (const { notice, desktopRunsAhead } of missed) announceMissed(notice, desktopRunsAhead, cloudAvailable)
    })
  }, [client, items, navigate, onDesktop, organizationId, queryClient, queryRoot])

  return null
}
