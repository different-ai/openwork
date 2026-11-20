// setTimeout fires immediately for delays above a signed 32-bit int.
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * How long a managed OpenCode engine may take to start before OpenWork gives
 * up on it. OPENWORK_ENGINE_SPAWN_TIMEOUT_MS lets operators allow slow cold
 * starts, such as antivirus scans of a freshly unpacked binary on Windows.
 * Unset or invalid keeps each engine's own default: v1 waits for its listening
 * line, v2 for its listening line and a passing health check.
 */
export function engineSpawnTimeoutMs(fallbackMs: number, env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.OPENWORK_ENGINE_SPAWN_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, MAX_TIMER_DELAY_MS) : fallbackMs;
}
