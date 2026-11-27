import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { constants, DatabaseSync } from "node:sqlite"
import { z } from "zod"
import type { StorageQueryResult, StorageStatement } from "./backend.js"

const PAGE_ROWS = 128
const catalogEntry = z.object({ type: z.enum(["table", "index"]), name: z.string(), sql: z.string() })
const columns = z.array(z.object({ name: z.string(), pk: z.number(), hidden: z.number() }))
const tableInfo = z.object({ wr: z.number() })

function identifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

export async function rebuildSqliteFile(query: (statement: StorageStatement) => Promise<StorageQueryResult>): Promise<Uint8Array | null> {
  const { rows } = await query({ sql: `SELECT type, name, sql FROM sqlite_schema
    WHERE type IN ('table', 'index') AND sql IS NOT NULL
      AND lower(name) NOT GLOB 'sqlite_*' AND lower(tbl_name) NOT GLOB 'sqlite_*'
      AND lower(name) NOT GLOB '_cf_*' AND lower(tbl_name) NOT GLOB '_cf_*'
      AND lower(name) NOT GLOB '_litestream_*' AND lower(tbl_name) NOT GLOB '_litestream_*'
    ORDER BY name` })
  const entries = z.array(catalogEntry).parse(rows)
  const tables = entries.filter((entry) => entry.type === "table")
  if (tables.length === 0) return null

  const directory = mkdtempSync(path.join(os.tmpdir(), "openwork-artifact-export-"))
  const file = path.join(directory, "artifact.sqlite")
  try {
    const database = new DatabaseSync(file, { enableForeignKeyConstraints: false })
    try {
      database.setAuthorizer((action) => [
        constants.SQLITE_ATTACH, constants.SQLITE_DETACH, constants.SQLITE_CREATE_VTABLE,
      ].some((denied) => denied === action) ? constants.SQLITE_DENY : constants.SQLITE_OK)
      database.exec("BEGIN")
      for (const { name, sql } of tables) {
        if (!/^CREATE TABLE\s/iu.test(sql)) throw new Error("Unsupported SQLite table definition")
        database.prepare(sql).run()
        const table = identifier(name)
        const info = columns.parse(database.prepare(`PRAGMA table_xinfo(${table})`).all())
        const fields = info.filter((column) => column.hidden === 0).map((column) => column.name)
        const keys = info.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk).map((column) => column.name)
        const { wr } = tableInfo.parse(database.prepare(`PRAGMA table_list(${table})`).get())
        const rowid = wr === 0 ? ["rowid", "_rowid_", "oid"].find((alias) => !info.some((column) => column.name.toLowerCase() === alias)) : undefined
        const order = rowid ? [rowid] : keys
        if (fields.length === 0 || order.length === 0) throw new Error("Unsupported SQLite table layout")
        const selection = fields.map(identifier).join(", ")
        const select = `SELECT ${selection} FROM ${table} ORDER BY ${order.map(identifier).join(", ")} LIMIT ? OFFSET ?`
        const insert = database.prepare(`INSERT INTO ${table} (${selection}) VALUES (${fields.map(() => "?").join(", ")})`)
        for (let offset = 0; ; offset += PAGE_ROWS) {
          const page = await query({ sql: select, params: [PAGE_ROWS, offset] })
          if (page.rows.length > PAGE_ROWS) throw new Error("Unexpected SQLite export page length")
          for (const row of page.rows) {
            insert.run(...fields.map((field) => {
              if (!Object.hasOwn(row, field)) throw new Error("Missing SQLite export column")
              return row[field]
            }))
          }
          if (page.rows.length < PAGE_ROWS) break
        }
      }
      for (const { type, sql } of entries) {
        if (type !== "index") continue
        if (!/^CREATE (?:UNIQUE )?INDEX\s/iu.test(sql)) throw new Error("Unsupported SQLite index definition")
        database.prepare(sql).run()
      }
      database.exec("COMMIT")
    } finally {
      database.close()
    }
    return new Uint8Array(readFileSync(file))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
