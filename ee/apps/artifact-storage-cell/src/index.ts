import { DurableObject } from "cloudflare:workers"
import { createHash, timingSafeEqual } from "node:crypto"
import { z } from "zod"

type Env = { ARTIFACT_STORAGE_TOKEN?: string; ARTIFACT_DATABASE: CellNamespace }

const DEN_ID = /^[a-z]{2,12}_[0-9a-z]{26}$/u
const MAX_BODY_BYTES = 1024 * 1024
const MAX_STATEMENTS = 64
const MAX_ROWS = 2_000
const WRITTEN = "written"
const value = z.union([z.string(), z.number(), z.null()])
const schema = z.object({ version: z.int().nonnegative(), statements: z.array(z.string().min(1)).max(MAX_STATEMENTS) })
const statement = z.object({ sql: z.string().min(1), params: z.array(value).optional() })
const queryBody = z.object({ schema, statement })
const writeBody = z.object({ schema, statements: z.array(statement).max(MAX_STATEMENTS) })

function error(status: number, code: string, message: string): Response {
  return Response.json({ error: code, message }, { status })
}

function digest(value: string) {
  return createHash("sha256").update(value).digest()
}

async function boundedBody(request: Request): Promise<Uint8Array<ArrayBuffer> | Response> {
  const tooLarge = () => error(413, "body_too_large", "Request bodies may not exceed 1 MiB.")
  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) return tooLarge()
  const reader = request.body?.getReader()
  if (!reader) return error(400, "invalid_body", "A JSON body is required.")
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_BODY_BYTES) {
        void reader.cancel().catch(() => {})
        return tooLarge()
      }
      if (value.byteLength > 0) chunks.push(value)
    }
  } catch {
    return error(400, "invalid_body", "The request body could not be read.")
  } finally {
    reader.releaseLock()
  }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const pathname = new URL(request.url).pathname
    if (request.method === "GET" && pathname === "/health") return Response.json({ ok: true })
    const token = env.ARTIFACT_STORAGE_TOKEN
    if (!token || token.length < 24) return error(503, "unavailable", "Artifact storage is not configured.")
    if (!timingSafeEqual(digest(request.headers.get("authorization") ?? ""), digest(`Bearer ${token}`))) {
      return error(401, "unauthorized", "A valid storage token is required.")
    }
    const match = /^\/v1\/databases\/([^/]*)\/([^/]*)(?:\/(query|write))?$/u.exec(pathname)
    if (!match) return error(404, "not_found", "Route not found.")
    const [, organizationId, appId, action] = match
    if (!DEN_ID.test(organizationId) || !DEN_ID.test(appId)) return error(400, "invalid_id", "The artifact database id is not valid.")
    if (request.method !== (action ? "POST" : "DELETE")) return error(405, "method_not_allowed", "Method not allowed.")
    const body = action ? await boundedBody(request) : undefined
    if (body instanceof Response) return body
    try {
      const cell = env.ARTIFACT_DATABASE.getByName(`${organizationId}/${appId}`)
      // Only the validated path, method and bounded body go to the cell. No caller headers.
      return await cell.fetch(new Request(`https://artifact-storage.internal/${action ?? ""}`, { method: request.method, body }))
    } catch {
      return error(503, "unavailable", "The artifact database is unavailable.")
    }
  },
}

export class ArtifactDatabase extends DurableObject<Env> {
  private appliedVersion = -1

  // Called in a synchronous transaction. Update appliedVersion only after commit.
  private applySchema(next: z.infer<typeof schema>) {
    if (next.version > this.appliedVersion) {
      for (const ddl of next.statements) this.ctx.storage.sql.exec(ddl).toArray()
    }
  }

  async fetch(request: Request): Promise<Response> {
    const storage = this.ctx.storage
    if (request.method === "DELETE") {
      return this.ctx.blockConcurrencyWhile(async () => {
        try {
          await storage.deleteAll()
          this.appliedVersion = -1
          return new Response(null, { status: 204 })
        } catch {
          return error(503, "unavailable", "The artifact database could not be deleted.")
        }
      })
    }
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return error(400, "invalid_body", "A valid JSON body is required.")
    }
    try {
      if (new URL(request.url).pathname === "/query") {
        const parsed = queryBody.safeParse(body)
        if (!parsed.success) return error(400, "invalid_body", "Invalid query body.")
        // A pure read of an unwritten cell skips schema DDL. The marker and the
        // first write commit together; deleteAll clears both SQL and the marker.
        if (storage.kv.get(WRITTEN) !== true) return Response.json({ rows: [] })
        const input = parsed.data
        if (input.schema.version > this.appliedVersion) {
          storage.transactionSync(() => this.applySchema(input.schema))
          this.appliedVersion = input.schema.version
        }
        const rows = []
        for (const row of storage.sql.exec(input.statement.sql, ...(input.statement.params ?? []))) {
          if (rows.length >= MAX_ROWS) return error(400, "too_many_rows", "A query may return at most 2,000 rows.")
          const parsedRow = z.record(z.string(), value).safeParse(row)
          if (!parsedRow.success) return error(400, "invalid_value", "Query values must be strings, numbers or null.")
          rows.push(parsedRow.data)
        }
        return Response.json({ rows })
      }
      const parsed = writeBody.safeParse(body)
      if (!parsed.success) return error(400, "invalid_body", "Invalid write body.")
      const input = parsed.data
      const changes = storage.transactionSync(() => {
        this.applySchema(input.schema)
        const counts = input.statements.map(({ sql, params }) => {
          const cursor = storage.sql.exec(sql, ...(params ?? []))
          // Drain RETURNING without retaining the result rows.
          for (const _ of cursor) { /* discard */ }
          return cursor.rowsWritten
        })
        if (storage.kv.get(WRITTEN) !== true) storage.kv.put(WRITTEN, true)
        return counts
      })
      this.appliedVersion = Math.max(this.appliedVersion, input.schema.version)
      return Response.json({ changes, sizeBytes: storage.sql.databaseSize })
    } catch (cause) {
      return error(400, "sql_error", cause instanceof Error ? cause.message : "SQLite operation failed.")
    }
  }
}
