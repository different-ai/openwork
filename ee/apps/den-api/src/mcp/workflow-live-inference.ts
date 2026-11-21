export function workflowRunNeedsLiveRuntime(code: string, body: unknown): boolean {
  if (!/\binput\s*(?:\?\.|\.)\s*runtime\b|\binput\s*\[\s*["']runtime["']\s*\]/.test(code)) return false
  if (body === undefined || body === null) return true
  return typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 0
}
