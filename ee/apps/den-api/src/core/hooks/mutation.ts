import type { AfterCommit } from "./types.js"

// Collects callbacks queued by tx-phase hooks and runs them, in queue order,
// once `run` (which owns the transaction) resolves. If `run` throws, the
// transaction rolled back and the queued callbacks are dropped.
//
// W0-P11 builds `withCoreMutation` (org-row lock + membership participants)
// on top of this when it replaces withOrganizationMembershipUsageMutation.
export async function runWithAfterCommit<T>(run: (afterCommit: AfterCommit) => Promise<T>): Promise<T> {
  const queue: Array<() => Promise<void>> = []
  const result = await run((callback) => {
    queue.push(callback)
  })
  for (const callback of queue) {
    await callback()
  }
  return result
}
