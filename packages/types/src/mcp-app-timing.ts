/** Numeric, bounded diagnostics: never record inputs, identities, URLs, or credentials. */
export function startMcpAppTiming(stage: string): () => number {
  const start = performance.now()
  return () => {
    const duration = performance.now() - start
    const name = `openwork.mcp-app.${stage}`
    performance.measure(name, { start, duration })
    if (performance.getEntriesByName(name).length > 100) performance.clearMeasures(name)
    return duration
  }
}

export async function timeMcpApp<T>(stage: string, run: () => Promise<T>): Promise<T> {
  const finish = startMcpAppTiming(stage)
  try { return await run() } finally { finish() }
}

