import { env } from "../env.js"
import type { McpAppStorageBackend } from "./backend.js"
import { createMcpAppStorageBackend } from "./backends.js"

let configured: McpAppStorageBackend | null | undefined

/**
 * This install's artifact storage backend, or null when it has none
 * configured. Den checks who is asking before it calls a backend.
 */
export function getMcpAppStorageBackend(): McpAppStorageBackend | null {
  if (configured === undefined) {
    const config = env.artifactStorage.backend
    configured = config ? createMcpAppStorageBackend(config) : null
    if (!config) console.warn("artifact_storage_backend_unavailable", { reason: env.artifactStorage.unavailableReason })
  }
  return configured
}

/** Tests swap the backend in; passing undefined goes back to the configured one. */
export function setMcpAppStorageBackendForTests(backend: McpAppStorageBackend | null | undefined): void {
  configured = backend
}
