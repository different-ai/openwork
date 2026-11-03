import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { importNodeSqlite } from "./runtime-db.js";

export type MigrationSession = { id: string; title: string; directory: string; parentId: string | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Shared by the worker and the non-Electron Bun host. Never called on Electron main. */
async function openReadOnly(database: string) {
  return typeof process.versions.bun === "string"
    ? new (await import("bun:sqlite")).Database(database, { readonly: true })
    : new (await importNodeSqlite()).DatabaseSync(database, { readOnly: true });
}

/** Exact existing revision framing and SQLite read transaction, including WAL.
 * Do not substitute file metadata, sample payloads, or reuse an earlier pass:
 * each call is an independent freshness observation in the switch protocol.
 */
export async function readHistoryRevision(database: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const db = await openReadOnly(database);
  try {
    const hash = createHash("sha256");
    db.exec("BEGIN");
    let chunks = 0;
    for (const table of ["session", "message", "part"]) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((column: unknown) => {
        if (!isRecord(column) || typeof column.name !== "string") {
          throw new Error("Could not inspect OpenCode v1 history columns.");
        }
        return column.name;
      });
      for (const row of db.prepare(`SELECT id FROM ${table} ORDER BY id`).iterate()) {
        signal?.throwIfAborted();
        if (!isRecord(row) || typeof row.id !== "string") {
          throw new Error("Could not inspect OpenCode v1 history identity.");
        }
        for (const name of columns) {
          const column = `"${name.replaceAll('"', '""')}"`;
          const value: unknown = db.prepare(`SELECT typeof(${column}) AS kind,
            length(CAST(${column} AS BLOB)) AS bytes FROM ${table} WHERE id = ?`).get(row.id);
          if (!isRecord(value) || !("kind" in value) || !("bytes" in value)) {
            throw new Error("Could not inspect OpenCode v1 history content.");
          }
          const bytes = typeof value.bytes === "number" ? value.bytes : 0;
          hash.update(JSON.stringify([table, row.id, name, value.kind, bytes]));
          // Never materialize an entire large tool payload in the host heap.
          const slice = db.prepare(`SELECT substr(CAST(${column} AS BLOB), ?, ?) AS chunk FROM ${table} WHERE id = ?`);
          for (let offset = 1; offset <= bytes; offset += 512 * 1024) {
            signal?.throwIfAborted();
            const part: unknown = slice.get(offset, 512 * 1024, row.id);
            if (!isRecord(part) || !(part.chunk instanceof Uint8Array)) {
              throw new Error("Could not read OpenCode v1 history content.");
            }
            hash.update(part.chunk);
            if (++chunks % 100 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
          }
        }
      }
    }
    return hash.digest("hex");
  } finally { db.close(); }
}

export function migrationSessionsFromRows(rows: unknown): MigrationSession[] {
  if (!Array.isArray(rows)) throw new Error("Could not read OpenCode v1 history inventory.");
  return rows.map((row: unknown) => {
    if (!isRecord(row) || typeof row.id !== "string" || typeof row.directory !== "string"
      || !isAbsolute(row.directory) || (row.parent_id !== null && typeof row.parent_id !== "string")) {
      throw new Error("OpenCode v1 history contains an invalid session. The original database was not changed.");
    }
    return { id: row.id, title: typeof row.title === "string" ? row.title : "", directory: row.directory, parentId: row.parent_id };
  });
}

export async function readHistoryInventory(database: string, signal?: AbortSignal): Promise<unknown[]> {
  signal?.throwIfAborted();
  const db = await openReadOnly(database);
  try {
    const rows: unknown[] = db.prepare("SELECT id, title, directory, parent_id FROM session ORDER BY time_created, id").all();
    migrationSessionsFromRows(rows);
    signal?.throwIfAborted();
    return rows;
  } finally { db.close(); }
}
