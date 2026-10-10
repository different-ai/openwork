/** The SQLite operations the runner needs, independent of the runtime that owns the database. */
export type SqlValue = string | number | null

export type SqlStatement = {
  get(...params: SqlValue[]): unknown
  all(...params: SqlValue[]): unknown[]
  run(...params: SqlValue[]): { changes: number }
  /** Must release its cursor when the caller stops early (context reads are deliberately bounded). */
  iterate(...params: SqlValue[]): Iterable<unknown>
}

export type SqlDriver = {
  exec(sql: string): void
  prepare(sql: string): SqlStatement
  /** A synchronous atomic transaction: commit on success, roll back on an exception. */
  transaction<T>(fn: () => T): T
  close(): void
}
