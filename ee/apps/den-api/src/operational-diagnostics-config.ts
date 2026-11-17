import { operationalDiagnosticsConfigSchema } from "@openwork/types/operational-diagnostics"

export function parseOperationalDiagnosticsEnv(source: Record<string, string | undefined>) {
  const raw = source.DEN_DIAGNOSTICS
  if (raw === undefined) return undefined
  try {
    return operationalDiagnosticsConfigSchema.parse(JSON.parse(raw))
  } catch {
    throw new Error("DEN_DIAGNOSTICS must be a valid diagnostics configuration")
  }
}
