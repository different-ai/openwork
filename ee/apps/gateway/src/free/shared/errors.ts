/** Every free Auto failure answers `{ error: { code, message } }` and is never cached. */
export function freeError(status: number, code: string, message = "Auto is unavailable. No request was sent.") {
  return Response.json({ error: { code, message } }, { status, headers: { "cache-control": "no-store" } })
}
/** A request the client can fix; nothing was reserved or sent. */
export class FreeRequestError extends Error {
  constructor(readonly status: 400 | 413, readonly code: string, message: string) { super(message) }
}
