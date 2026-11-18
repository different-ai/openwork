/**
 * A Workflow saved from a live test reads `input.runtime` (today, now, the
 * caller's day bounds) and takes no other input. Callers that only know "run
 * it again" (the Library's Run button, a teammate, chat) send no input, so the
 * run gets the runtime it was tested with instead of crashing on
 * `input.runtime.now`. Explicit input always wins.
 */
export function workflowRunNeedsLiveRuntime(code: string, body: unknown): boolean {
  if (!/\binput\s*(?:\?\.|\.)\s*runtime\b|\binput\s*\[\s*["']runtime["']\s*\]/.test(code)) return false
  if (body === undefined || body === null) return true
  return typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 0
}
