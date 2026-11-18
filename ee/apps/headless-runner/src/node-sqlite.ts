import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { SqlDriver } from "./sql.js"

/** The existing Node database, including its durability settings and lazy context reads. */
export function nodeSqlite(path: string): SqlDriver {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  // secure_delete FAST: space freed inside a page (a row rewritten or deleted) is zeroed at no extra I/O, so a deleted
  // conversation's bytes don't linger in the file (storage/ scrubs and deletes; see README "Deleting a conversation").
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA secure_delete = FAST;")
  return {
    exec: (sql) => db.exec(sql),
    prepare(sql) {
      const statement = db.prepare(sql)
      return {
        get: (...params) => statement.get(...params),
        all: (...params) => statement.all(...params),
        run: (...params) => ({ changes: Number(statement.run(...params).changes) }),
        iterate: (...params) => statement.iterate(...params),
      }
    },
    transaction<T>(fn: () => T): T {
      db.exec("BEGIN IMMEDIATE")
      try {
        const result = fn()
        db.exec("COMMIT")
        return result
      } catch (error) {
        db.exec("ROLLBACK")
        throw error
      }
    },
    close: () => db.close(),
  }
}
