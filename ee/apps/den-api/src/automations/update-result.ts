function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function changedRows(result: unknown): number | null {
  if (Array.isArray(result)) {
    for (const value of result) {
      const nested = changedRows(value)
      if (nested !== null) return nested
    }
    return null
  }
  if (!isRecord(result)) return null
  if (typeof result.rowsAffected === "number") return result.rowsAffected
  if (typeof result.affectedRows === "number") return result.affectedRows
  return null
}

export function automationUpdateChangedRows(result: unknown): boolean {
  const rows = changedRows(result)
  return rows !== null && rows > 0
}
