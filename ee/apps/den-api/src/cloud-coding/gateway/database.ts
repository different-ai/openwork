export function didUpdate(result: unknown): boolean {
  if (Array.isArray(result)) return didUpdate(result[0])
  if (!result || typeof result !== "object") return false
  if ("rowsAffected" in result && typeof result.rowsAffected === "number") return result.rowsAffected > 0
  return "affectedRows" in result && typeof result.affectedRows === "number" && result.affectedRows > 0
}
