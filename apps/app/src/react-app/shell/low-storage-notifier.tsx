import { useEffect, useRef } from "react"
import { useQuery } from "@tanstack/react-query"

import { markFeatureUsed } from "@/app/lib/den"
import { createOpenworkServerClient, isLoopbackOpenworkServerUrl, openworkDiskFullEvent, type OpenworkDiskSpace } from "@/app/lib/openwork-server"
import { toast } from "@/components/ui/sonner"
import { useDesktopFeature } from "@/react-app/domains/session/status/use-desktop-feature"
import { LOW_STORAGE_FEATURE, lowStorageCleanedUp, lowStorageNotice, parseLowStorageAnnouncement, type LowStorageAnnouncement } from "./low-storage"
import { resolveOpenworkConnection } from "./openwork-connection"

const LOW_STORAGE_POLL_MS = 5 * 60 * 1000
const LOW_STORAGE_TOAST_ID = "low-storage"
const ANNOUNCED_KEY = "openwork.lowStorageAnnounced.v1"

function readAnnounced(): LowStorageAnnouncement | null {
  try {
    return parseLowStorageAnnouncement(window.localStorage.getItem(ANNOUNCED_KEY))
  } catch {
    return null
  }
}

function writeAnnounced(announcement: LowStorageAnnouncement | null) {
  try {
    if (announcement) window.localStorage.setItem(ANNOUNCED_KEY, JSON.stringify(announcement))
    else window.localStorage.removeItem(ANNOUNCED_KEY)
  } catch {
  }
}

async function readLocalDiskSpace(): Promise<OpenworkDiskSpace | null> {
  const connection = await resolveOpenworkConnection()
  const onThisComputer = connection.source === "desktop-runtime" || isLoopbackOpenworkServerUrl(connection.normalizedBaseUrl)
  if (!onThisComputer) return null
  return createOpenworkServerClient({
    baseUrl: connection.normalizedBaseUrl,
    token: connection.resolvedToken || undefined,
    hostToken: connection.resolvedHostToken || undefined,
  }).diskSpace()
}

export function LowStorageNotifier() {
  const enabled = useDesktopFeature(LOW_STORAGE_FEATURE)
  const saveFailed = useRef(false)
  const shown = useRef(false)
  const { data: status, dataUpdatedAt, refetch } = useQuery({
    queryKey: ["openwork", "disk-space"],
    queryFn: readLocalDiskSpace,
    enabled,
    refetchInterval: LOW_STORAGE_POLL_MS,
    refetchIntervalInBackground: true,
    retry: false,
  })

  useEffect(() => {
    if (!enabled) return
    const recheck = () => {
      saveFailed.current = true
      void refetch()
    }
    window.addEventListener(openworkDiskFullEvent, recheck)
    return () => window.removeEventListener(openworkDiskFullEvent, recheck)
  }, [enabled, refetch])

  useEffect(() => {
    const dismiss = () => {
      if (shown.current) toast.dismiss(LOW_STORAGE_TOAST_ID)
      shown.current = false
    }
    if (!enabled) return dismiss()
    if (!status) return
    if (status.level === "ok") {
      dismiss()
      if (lowStorageCleanedUp(status)) writeAnnounced(null)
      saveFailed.current = false
      return
    }
    const now = Date.now()
    const notice = lowStorageNotice({ status, announced: readAnnounced(), now, saveFailed: saveFailed.current })
    saveFailed.current = false
    if (!notice) return
    writeAnnounced({ level: notice.level, at: now })
    markFeatureUsed(LOW_STORAGE_FEATURE)
    shown.current = true
    const show = notice.level === "critical" ? toast.error : toast.warning
    show(notice.title, { id: LOW_STORAGE_TOAST_ID, description: notice.description, duration: Infinity })
  }, [enabled, status, dataUpdatedAt])

  return null
}
