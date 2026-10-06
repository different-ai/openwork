import { isGatewayUsageDeadlock } from "./gateway-usage-errors"

export type GatewayUsageTransactionDb<Tx> = {
  transaction<T>(run: (tx: Tx) => Promise<T>): Promise<T>
}

/**
 * Shared by the accounting and admission entry points: runs one usage
 * transaction and retries it twice on a MySQL deadlock, with a short backoff.
 */
export async function runGatewayUsageTransaction<Tx, T>(
  db: GatewayUsageTransactionDb<Tx>,
  clock: () => Date,
  run: (tx: Tx, now: Date) => Promise<T>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.transaction((tx) => run(tx, clock()))
    } catch (error) {
      if (!isGatewayUsageDeadlock(error) || attempt >= 2) throw error
      await sleep(5 * (attempt + 1))
    }
  }
}
