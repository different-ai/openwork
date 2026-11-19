import type { OpenworkDiskSpace } from "@/app/lib/openwork-server"
import { formatFileSize } from "@/lib/utils"

export const LOW_STORAGE_FEATURE = "lowStorageWarning"

export const LOW_STORAGE_CLEANED_UP_BYTES = 4 * 1024 ** 3

export const LOW_STORAGE_SAVE_FAILED_REPEAT_MS = 60 * 60 * 1000

export type LowStorageLevel = "low" | "critical"

export type LowStorageAnnouncement = { level: LowStorageLevel; at: number }

export type LowStorageNotice = { level: LowStorageLevel; title: string; description: string }

export function lowStorageNotice(input: {
  status: OpenworkDiskSpace
  announced: LowStorageAnnouncement | null
  now: number
  saveFailed: boolean
}): LowStorageNotice | null {
  const { status, announced, now, saveFailed } = input
  if (status.level === "ok" || status.freeBytes === null) return null
  const alreadyTold = announced !== null && (announced.level === "critical" || status.level === "low")
  if (alreadyTold && !(saveFailed && now - announced.at >= LOW_STORAGE_SAVE_FAILED_REPEAT_MS)) return null
  const left = `${formatFileSize(status.freeBytes)} left.`
  return status.level === "critical"
    ? { level: "critical", title: "Your disk is full", description: `${left} OpenWork can't save changes until you free up space.` }
    : { level: "low", title: "Your disk is almost full", description: `${left} Free up space so OpenWork can keep saving your work.` }
}

export function lowStorageCleanedUp(status: OpenworkDiskSpace): boolean {
  return status.level === "ok" && status.freeBytes !== null && status.freeBytes >= LOW_STORAGE_CLEANED_UP_BYTES
}

/** Reads a stored announcement defensively: anything unexpected reads as never announced. */
export function parseLowStorageAnnouncement(raw: string | null): LowStorageAnnouncement | null {
  if (!raw) return null
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== "object" || value === null) return null
    const level: unknown = Reflect.get(value, "level")
    const at: unknown = Reflect.get(value, "at")
    if ((level !== "low" && level !== "critical") || typeof at !== "number" || !Number.isFinite(at)) return null
    return { level, at }
  } catch {
    return null
  }
}
