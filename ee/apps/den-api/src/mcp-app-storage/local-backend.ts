import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import {
  McpAppStorageBackendError,
  type McpAppStorageBackend,
  type McpAppStorageSchema,
  type StorageDatabaseRef,
  type StorageStatement,
  type StorageValue,
} from "./backend.js"

const DEN_ID = /^[a-z]{2,12}_[0-9a-z]{26}$/u
const BUSY_TIMEOUT_MS = 5_000

function storageValue(value: unknown): StorageValue {
  if (value === null || typeof value === "string" || typeof value === "number") return value
  if (typeof value === "bigint") return Number(value)
  return null
}

function failure(action: string, cause: unknown): McpAppStorageBackendError {
  return new McpAppStorageBackendError(`The local artifact database could not ${action}.`, { cause })
}

/**
 * SQLite files on this Den's own disk, one per artifact, at
 * `<directory>/<organizationId>/<appId>.sqlite`. For development and tests:
 * a second Den instance would not see these files, so an install that runs
 * more than one Den uses the celld backend instead.
 *
 * Each call opens the file, runs, and closes it, so nothing is held between
 * requests and a deleted database leaves no open handle behind.
 */
export function createLocalStorageBackend(input: { directory: string; schema: McpAppStorageSchema }): McpAppStorageBackend {
  const fileFor = (ref: StorageDatabaseRef) => {
    if (!DEN_ID.test(ref.organizationId) || !DEN_ID.test(ref.appId)) throw new McpAppStorageBackendError("The artifact database id is not valid.")
    return path.join(input.directory, ref.organizationId, `${ref.appId}.sqlite`)
  }
  const open = (file: string) => {
    mkdirSync(path.dirname(file), { recursive: true })
    const database = new DatabaseSync(file)
    database.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
    for (const statement of input.schema.statements) database.exec(statement)
    return database
  }
  const sizeOf = (database: DatabaseSync) => {
    const pages = storageValue(database.prepare("PRAGMA page_count").get()?.page_count)
    const pageSize = storageValue(database.prepare("PRAGMA page_size").get()?.page_size)
    return typeof pages === "number" && typeof pageSize === "number" ? pages * pageSize : 0
  }

  return {
    kind: "local",
    async query(ref, statement) {
      const file = fileFor(ref)
      if (!existsSync(file)) return { rows: [] }
      let database: DatabaseSync | undefined
      try {
        database = open(file)
        const rows = database.prepare(statement.sql).all(...(statement.params ?? []))
        return { rows: rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, storageValue(value)]))) }
      } catch (cause) {
        throw failure("be read", cause)
      } finally {
        database?.close()
      }
    },
    async write(ref, statements: StorageStatement[]) {
      const file = fileFor(ref)
      let database: DatabaseSync | undefined
      try {
        database = open(file)
        database.exec("BEGIN IMMEDIATE")
        try {
          const changes = statements.map((statement) => Number(database?.prepare(statement.sql).run(...(statement.params ?? [])).changes ?? 0))
          database.exec("COMMIT")
          return { changes, sizeBytes: sizeOf(database) }
        } catch (cause) {
          database.exec("ROLLBACK")
          throw cause
        }
      } catch (cause) {
        throw failure("be changed", cause)
      } finally {
        database?.close()
      }
    },
    async export(ref) {
      const file = fileFor(ref)
      if (!existsSync(file)) return null
      const copy = path.join(path.dirname(file), `.export-${randomUUID()}.sqlite`)
      let database: DatabaseSync | undefined
      try {
        database = open(file)
        database.prepare("VACUUM INTO ?").run(copy)
        return new Uint8Array(readFileSync(copy))
      } catch (cause) {
        throw failure("be exported", cause)
      } finally {
        database?.close()
        rmSync(copy, { force: true })
      }
    },
    async delete(ref) {
      const file = fileFor(ref)
      try {
        for (const suffix of ["", "-journal", "-wal", "-shm"]) rmSync(`${file}${suffix}`, { force: true })
      } catch (cause) {
        throw failure("be deleted", cause)
      }
    },
  }
}
