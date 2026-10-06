import type { db } from "../db.js"

export type CoreDatabase = typeof db
export type CoreTx = Parameters<Parameters<CoreDatabase["transaction"]>[0]>[0]
// Read-only handle accepted by authority queries: the root database or any transaction.
export type CoreReader = Pick<CoreDatabase, "select">
