import type { EnterpriseMcpDiscoveryCheck } from "@openwork/enterprise-mcp-client"
import type { SSEStreamingApi } from "hono/streaming"

/** Ordered, backpressure-aware progress; disconnects cancel the same discovery. */
export async function streamMcpDiscovery<Result>(input: {
  stream: SSEStreamingApi
  signal: AbortSignal
  discover: (signal: AbortSignal, onCheck: (check: EnterpriseMcpDiscoveryCheck) => void) => Promise<Result>
}): Promise<void> {
  const controller = new AbortController()
  let closed = false
  const close = () => {
    closed = true
    controller.abort()
  }
  input.stream.onAbort(close)
  input.signal.addEventListener("abort", close, { once: true })
  if (input.signal.aborted) close()
  let pending = Promise.resolve()
  const enqueue = (event: string, data: unknown) => {
    pending = pending.then(async () => {
      if (!closed) await input.stream.writeSSE({ event, data: JSON.stringify(data) })
    }).catch(close)
  }
  try {
    if (closed) return
    const result = await input.discover(controller.signal, (check) => enqueue("check", check))
    enqueue("result", result)
  } catch {
    enqueue("error", { message: "The server check could not finish. Try again." })
  } finally {
    await pending
    close()
    input.signal.removeEventListener("abort", close)
  }
}
