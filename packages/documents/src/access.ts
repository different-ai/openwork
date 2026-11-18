import { DocumentsError } from "./index"

/** A failed listing is not proof that every open file lost its authorization. */
export function documentsAccessFailure(error: unknown): "signin" | "connection" | "blocked" | "disabled" | null {
  if (!(error instanceof DocumentsError)) return null
  if (["workbot_documents_not_enabled", "feature_disabled"].includes(error.code)) return "disabled"
  if (error.status === 401) return "signin"
  if (error.code === "needs_connection") return "connection"
  // Unknown conflicts may be refreshable, but must still mask cached content.
  if (error.status === 403 || error.status === 409) return "blocked"
  return null
}

/** Recovery is memory-only, scoped to one mounted identity, and never indefinite. */
export const DOCUMENT_RECOVERY_MS = 15 * 60 * 1000

/** Existing locked files keep their deadline; newly locked files get their own. */
export function lockDocumentRecovery(current: ReadonlyMap<string, number>, ids: readonly string[], now = Date.now()): ReadonlyMap<string, number> {
  const next = new Map(current)
  for (const id of ids) if (!next.has(id)) next.set(id, now + DOCUMENT_RECOVERY_MS)
  return next
}

export function expiredDocumentRecovery(locks: ReadonlyMap<string, number>, now = Date.now()): string[] {
  return [...locks].flatMap(([id, until]) => until <= now ? [id] : [])
}
