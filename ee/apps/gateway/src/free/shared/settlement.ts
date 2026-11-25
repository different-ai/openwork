import { setTimeout as delay } from "node:timers/promises"

export async function retryFreeSettlement(work: () => Promise<unknown>, report: (error: unknown) => void,
  wait: (milliseconds: number) => Promise<unknown> = delay): Promise<void> {
  let attempts = 0
  for (;;) {
    try { await work(); return }
    catch (error) {
      if (attempts++ === 0) {
        try { report(error) } catch {}
      }
      await wait(Math.min(25 * 2 ** Math.min(attempts - 1, 8), 5000))
    }
  }
}
