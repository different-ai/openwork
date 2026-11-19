import { SessionRunnerError } from "./types.ts"

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Remote-session operation cancelled.", "AbortError")
}
/** Even a misbehaving adapter/fetch cannot hold the serialized runner forever. */
export async function bounded<T>(signal: AbortSignal, timeoutMs: number, effect: (signal: AbortSignal) => Promise<T>): Promise<T> {
  throwIfAborted(signal)
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort = () => {}
  const interrupted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      controller.abort()
      reject(new DOMException("Remote-session operation cancelled.", "AbortError"))
    }
    signal.addEventListener("abort", onAbort, { once: true })
    timer = setTimeout(() => {
      controller.abort()
      reject(new SessionRunnerError("operation_timeout", "Remote-session operation timed out; its outcome may be uncertain."))
    }, timeoutMs)
  })
  try { return await Promise.race([Promise.resolve().then(() => { throwIfAborted(controller.signal); return effect(controller.signal) }), interrupted]) }
  finally {
    if (timer !== undefined) clearTimeout(timer)
    signal.removeEventListener("abort", onAbort)
  }
}
