import type { DenServerFacts } from "@openwork/types/den/service-readiness"
import { env } from "./env.js"

// Per process: each replica answers with its own start, never a cached one.
const processStartedAt = Date.now() - process.uptime() * 1000
let startupMs: number | null = null

/** Call once from the HTTP server's listen callback. Later calls keep the first time. */
export function markServerListening(): void {
  startupMs ??= Math.max(0, Math.round(process.uptime() * 1000))
}

/** The Den replica answering this request: build version and how long it took to accept connections. */
export function denServerFacts(): DenServerFacts {
  return {
    version: env.serviceVersion.trim().slice(0, 64) || "dev",
    startedAt: new Date(processStartedAt).toISOString(),
    startupMs,
  }
}
