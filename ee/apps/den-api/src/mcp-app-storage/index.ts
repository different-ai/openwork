import { env } from "../env.js"
import type { McpAppStorageBackend } from "./backend.js"
import { createMcpAppStorageBackend } from "./backends.js"

let configured: McpAppStorageBackend | null | undefined

export function getMcpAppStorageBackend(): McpAppStorageBackend | null {
  if (configured === undefined) {
    const config = env.artifactStorage.backend
    configured = config ? createMcpAppStorageBackend(config) : null
    if (!config) console.warn("artifact_storage_backend_unavailable", { reason: env.artifactStorage.unavailableReason })
  }
  return configured
}

export function setMcpAppStorageBackendForTests(backend: McpAppStorageBackend | null | undefined): void {
  configured = backend
}
