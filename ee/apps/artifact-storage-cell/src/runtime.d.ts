// Only the subset of the Workers Durable Object API used by this package.
type SqlValue = string | number | null

type SqlCursor = Iterable<Record<string, SqlValue | ArrayBuffer>> & {
  toArray(): Array<Record<string, SqlValue | ArrayBuffer>>
  readonly rowsWritten: number
}

type CellStorage = {
  readonly sql: {
    exec(statement: string, ...params: SqlValue[]): SqlCursor
    readonly databaseSize: number
  }
  readonly kv: {
    get(key: string): unknown
    put(key: string, value: unknown): void
  }
  transactionSync<T>(fn: () => T): T
  deleteAll(): Promise<void>
}

type CellNamespace = {
  getByName(name: string): { fetch(request: Request): Promise<Response> }
}

declare module "cloudflare:workers" {
  export class DurableObject<Env> {
    constructor(ctx: DurableObjectState, env: Env)
    protected ctx: DurableObjectState
  }
}

type DurableObjectState = {
  readonly storage: CellStorage
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>
}
