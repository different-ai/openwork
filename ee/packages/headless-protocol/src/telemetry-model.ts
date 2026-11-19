/** Model identity is not a channel for reflected credentials or arbitrary provider prose. */
export function telemetryModelId(value: string, sensitiveValues: readonly string[] = []): string | null {
  if (value === "unreported" || !/^[A-Za-z0-9][A-Za-z0-9_.:/@+-]{0,127}$/.test(value)) return null
  if (/^(?:sk-|ow_|key[-_])/i.test(value)) return null
  if (sensitiveValues.some(secret => secret.length > 0 && (value.includes(secret) || secret.includes(value)))) return null
  return value
}
