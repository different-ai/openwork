export type SqlValue = string | number | null

export type SqlStatement = {
  get(...params: SqlValue[]): unknown
  all(...params: SqlValue[]): unknown[]
  run(...params: SqlValue[]): { changes: number }
  iterate(...params: SqlValue[]): Iterable<unknown>
}

export type SqlDriver = {
  exec(sql: string): void
  prepare(sql: string): SqlStatement
  transaction<T>(fn: () => T): T
  close(): void
}
