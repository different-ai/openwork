import { z } from "zod"
import {
  McpAppStorageBackendError,
  type McpAppStorageBackend,
  type McpAppStorageSchema,
  type StorageDatabaseRef,
} from "./backend.js"
import { rebuildSqliteFile } from "./sqlite-file.js"

const DEN_ID = /^[a-z]{2,12}_[0-9a-z]{26}$/u
const REQUEST_TIMEOUT_MS = 15_000
const queryResult = z.object({ rows: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.null()]))).max(2_000) })
const writeResult = z.object({ changes: z.array(z.int().nonnegative()), sizeBytes: z.int().nonnegative() })

export function createCelldStorageBackend(input: { url: string; token: string; schema: McpAppStorageSchema; fetch?: typeof fetch }): McpAppStorageBackend {
  const fetchRequest = input.fetch ?? fetch
  const base = input.url.replace(/\/+$/u, "")

  function pathFor(ref: StorageDatabaseRef) {
    if (!DEN_ID.test(ref.organizationId) || !DEN_ID.test(ref.appId)) {
      throw new McpAppStorageBackendError("The artifact database id is not valid.")
    }
    return `${base}/v1/databases/${ref.organizationId}/${ref.appId}`
  }

  async function request<T>(ref: StorageDatabaseRef, action: "query" | "write" | "delete", init: RequestInit, parse: (response: Response) => Promise<T>): Promise<T> {
    const resource = pathFor(ref)
    try {
      const response = await fetchRequest(action === "delete" ? resource : `${resource}/${action}`, {
        ...init,
        headers: { authorization: `Bearer ${input.token}`, ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      return await parse(response)
    } catch {
      // Fetch, validation, and remote SQLite errors can contain URLs, request
      // headers, or row values. Do not expose even the error's cause to Den.
      throw new McpAppStorageBackendError(`The celld artifact database ${action} failed.`)
    }
  }

  const backend: McpAppStorageBackend = {
    kind: "celld",
    async query(ref, statement) {
      return request(ref, "query", { method: "POST", body: JSON.stringify({ schema: input.schema, statement }) }, async (response) => {
        if (response.status !== 200) throw new Error("Unexpected status")
        return queryResult.parse(await response.json())
      })
    },
    async write(ref, statements) {
      return request(ref, "write", { method: "POST", body: JSON.stringify({ schema: input.schema, statements }) }, async (response) => {
        if (response.status !== 200) throw new Error("Unexpected status")
        const result = writeResult.parse(await response.json())
        if (result.changes.length !== statements.length) throw new Error("Unexpected number of change counts")
        return result
      })
    },
    async export(ref) {
      pathFor(ref)
      try {
        return await rebuildSqliteFile((statement) => backend.query(ref, statement))
      } catch {
        throw new McpAppStorageBackendError("The celld artifact database export failed.")
      }
    },
    async delete(ref) {
      await request(ref, "delete", { method: "DELETE" }, async (response) => {
        if (response.status !== 204 && response.status !== 404) throw new Error("Unexpected status")
      })
    },
  }
  return backend
}
