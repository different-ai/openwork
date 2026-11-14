import type { OpenworkDiskSpace } from "@/app/lib/openwork-server"
import { formatFileSize } from "@/lib/utils"

export const LOW_STORAGE_FEATURE = "lowStorageWarning"

/** A warning that was dismissed is not repeated sooner than this unless the disk gets fuller. */
export const LOW_STORAGE_REPEAT_MS = 24 * 60 * 60 * 1000

export type LowStorageLevel = "low" | "critical"

export type LowStorageAnnouncement = { level: LowStorageLevel; at: number }

export type LowStorageNotice = { level: LowStorageLevel; title: string; description: string }

/**
 * The warning to show for a disk-space reading, or null when there is nothing
 * new to say: the disk has room, or the person was already told and it has
 * not become fuller since. A save that just failed for lack of space is
 * always worth saying again.
 */
export function lowStorageNotice(input: {
  status: OpenworkDiskSpace
  announced: LowStorageAnnouncement | null
  now: number
  saveFailed: boolean
}): LowStorageNotice | null {
  const { status, announced, now, saveFailed } = input
  if (status.level === "ok" || status.freeBytes === null) return null
  const alreadyTold = announced !== null
    && now - announced.at < LOW_STORAGE_REPEAT_MS
    && (announced.level === "critical" || status.level === "low")
  if (alreadyTold && !saveFailed) return null
  const left = `${formatFileSize(status.freeBytes)} left.`
  return status.level === "critical"
    ? { level: "critical", title: "Your disk is full", description: `${left} OpenWork can't save changes until you free up space.` }
    : { level: "low", title: "Your disk is almost full", description: `${left} Free up space so OpenWork can keep saving your work.` }
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
