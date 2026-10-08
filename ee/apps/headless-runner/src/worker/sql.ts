import type { SqlDriver, SqlValue } from "../sql.js"

/** SQLite belongs to the actor runtime, not the runner. Writes always drain their cursors before an effect. */
export function durableObjectSql(storage: DurableObjectStorage): SqlDriver {
  return {
    exec: (sql) => { storage.sql.exec(sql).toArray() },
    prepare(sql) {
      return {
        get: (...params) => storage.sql.exec(sql, ...params).toArray()[0],
        all: (...params) => storage.sql.exec(sql, ...params).toArray(),
        run(...params) {
          const cursor = storage.sql.exec(sql, ...params)
          cursor.toArray()
          return { changes: cursor.rowsWritten }
        },
        // Context reads stop early. Page instead of materializing the entire history or leaving an open cursor.
        *iterate(...params: SqlValue[]) {
          const pageSize = 128
          for (let offset = 0; ; offset += pageSize) {
            const rows = storage.sql.exec(`SELECT * FROM (${sql}) LIMIT ? OFFSET ?`, ...params, pageSize, offset).toArray()
            yield* rows
            if (rows.length < pageSize) return
          }
        },
      }
    },
    transaction: (fn) => storage.transactionSync(fn),
    close() { /* The host owns the connection and the actor's lifetime. */ },
  }
}
