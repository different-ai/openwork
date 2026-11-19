/** Retry a dirty inventory, never poll a successfully reconciled one. */
export function inventoryRetry(retry: () => void, baseMs = 1000) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let failures = 0
  const cancel = () => { clearTimeout(timer); timer = undefined }
  return {
    cancel,
    reset() { cancel(); failures = 0 },
    schedule() {
      if (timer) return
      const timeout = Math.min(30_000, baseMs * 2 ** Math.min(failures++, 5))
      timer = setTimeout(() => { timer = undefined; retry() }, timeout)
      timer.unref?.()
    },
  }
}
