import { pathToFileURL } from "node:url"
import type { AuditDatabase } from "@openwork-ee/den-db/audit-log"
import { AUDIT_PILOT_HELP, AuditPilotError, initializeAuditPilot, parsePilotArgs, pilotConfigSummary, previewPilotRetention, type PilotFlags } from "../src/audit/pilot-policy.js"

export type PilotRuntime = { database: AuditDatabase; flags: PilotFlags; close: () => Promise<void> }

async function configuredRuntime(): Promise<PilotRuntime> {
  const { env } = await import("../src/env.js")
  const { db, client } = await import("../src/db.js")
  return {
    database: db,
    flags: { auditCaptureEnabled: env.auditCaptureEnabled, auditVisibilityEnabled: env.auditVisibilityEnabled },
    close: async () => { if ("end" in client) await client.end() },
  }
}

export async function runAuditPilot(args: string[], io: { out: (text: string) => void; error: (text: string) => void }, loadRuntime: () => Promise<PilotRuntime> = configuredRuntime): Promise<number> {
  let runtime: PilotRuntime | undefined
  try {
    const command = parsePilotArgs(args)
    if (command.mode === "help") {
      io.out(AUDIT_PILOT_HELP)
      return 0
    }
    runtime = await loadRuntime()
    if (command.mode === "preview-retention") {
      io.out(JSON.stringify(await previewPilotRetention(runtime.database, command.organizationId), null, 2))
    } else {
      const status = await initializeAuditPilot(runtime.database, command.config, command.mode === "apply")
      io.out(JSON.stringify({ config: pilotConfigSummary(command.config, runtime.flags, command.mode), status }, null, 2))
    }
    return 0
  } catch (error) {
    io.error(error instanceof AuditPilotError ? error.code : "audit_pilot_failed_outcome_unverified: inspect policy/history before retrying; raw error withheld")
    return 1
  } finally {
    if (runtime) {
      try { await runtime.close() } catch { io.error("audit_pilot_connection_close_failed: preceding transaction outcome is unchanged") }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runAuditPilot(process.argv.slice(2), { out: (text) => console.log(text), error: (text) => console.error(text) })
}
