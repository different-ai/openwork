import { setTimeout as delay } from "node:timers/promises"

/**
 * Keep the original idempotent settlement alive through a database outage, independently of
 * the client signal. In particular, a failed write never replaces a known receipt with an estimate.
 * The response cannot finish until its charge commits. As with other in-process Gateway writes,
 * an interrupted Gateway process still requires accounting reconciliation.
 */
export async function retryFreeSettlement(work: () => Promise<unknown>, report: (error: unknown) => void,
  wait: (milliseconds: number) => Promise<unknown> = delay): Promise<void> {
  let attempts = 0
  for (;;) {
    try { await work(); return }
    catch (error) {
      if (attempts++ === 0) {
        try { report(error) } catch { /* A telemetry sink must not interrupt accounting recovery. */ }
      }
      await wait(Math.min(25 * 2 ** Math.min(attempts - 1, 8), 5000))
    }
  }
}
