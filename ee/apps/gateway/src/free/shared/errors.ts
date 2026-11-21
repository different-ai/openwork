export function freeError(status: number, code: string, message = "Auto is unavailable. No request was sent.") {
  return Response.json({ error: { code, message } }, { status, headers: { "cache-control": "no-store" } })
}
export class FreeRequestError extends Error {
  constructor(readonly status: 400 | 413, readonly code: string, message: string) { super(message) }
}
