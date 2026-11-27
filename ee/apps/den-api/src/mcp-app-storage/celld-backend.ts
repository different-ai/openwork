import { McpAppStorageBackendError, type McpAppStorageBackend, type McpAppStorageSchema } from "./backend.js"

/** Placeholder until the celld adapter lands in this branch. */
export function createCelldStorageBackend(_input: { url: string; token: string; schema: McpAppStorageSchema; fetch?: typeof fetch }): McpAppStorageBackend {
  const unavailable = async (): Promise<never> => {
    throw new McpAppStorageBackendError("The celld artifact storage backend is not available.")
  }
  return { kind: "celld", query: unavailable, write: unavailable, export: unavailable, delete: unavailable }
}
