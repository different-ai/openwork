import type { DenServerFacts } from "@openwork/types/den/service-readiness"
import { env } from "./env.js"

const processStartedAt = Date.now() - process.uptime() * 1000
let startupMs: number | null = null

export function markServerListening(): void {
  startupMs ??= Math.max(0, Math.round(process.uptime() * 1000))
}

export function denServerFacts(): DenServerFacts {
  return {
    version: env.serviceVersion.trim().slice(0, 64) || "dev",
    startedAt: new Date(processStartedAt).toISOString(),
    startupMs,
  }
}
