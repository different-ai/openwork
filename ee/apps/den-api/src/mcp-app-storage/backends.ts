import { MCP_APP_STORAGE_SCHEMA, type McpAppStorageBackend } from "./backend.js"
import { createCelldStorageBackend } from "./celld-backend.js"
import type { ArtifactStorageBackendConfig } from "./config.js"
import { createLocalStorageBackend } from "./local-backend.js"

export function createMcpAppStorageBackend(config: ArtifactStorageBackendConfig): McpAppStorageBackend {
  return config.kind === "celld"
    ? createCelldStorageBackend({ url: config.url, token: config.token, schema: MCP_APP_STORAGE_SCHEMA })
    : createLocalStorageBackend({ directory: config.directory, schema: MCP_APP_STORAGE_SCHEMA })
}
