import { createHash } from "node:crypto";
import { importNodeSqlite } from "./runtime-db.js";

export interface EngineAutoUpgradeRetry {
  attempts: number;
  retryAt: number;
}

/** One attempt per boot; checkpointed failures back off from one minute to one day. */
export function engineAutoUpgradeRetry(attempts: number, now = Date.now()): EngineAutoUpgradeRetry {
  const next = Math.min(Math.max(0, attempts) + 1, 32);
  return { attempts: next, retryAt: now + Math.min(60_000 * 2 ** (next - 1), 86_400_000) };
}

/** Hash chat content through SQLite (including the WAL), not file timestamps.
 * Engine probes legitimately update project bookkeeping while no chat changes.
 */
export async function historyRevision(database: string): Promise<string> {
  const db = typeof process.versions.bun === "string"
    ? new (await import("bun:sqlite")).Database(database, { readonly: true })
    : new (await importNodeSqlite()).DatabaseSync(database, { readOnly: true });
  try {
    const hash = createHash("sha256");
    db.exec("BEGIN");
    let chunks = 0;
    for (const table of ["session", "message", "part"]) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((column: unknown) => {
        if (typeof column !== "object" || column === null || !("name" in column) || typeof column.name !== "string") {
          throw new Error("Could not inspect OpenCode v1 history columns.");
        }
        return column.name;
      });
      for (const row of db.prepare(`SELECT id FROM ${table} ORDER BY id`).iterate()) {
        if (typeof row !== "object" || row === null || !("id" in row) || typeof row.id !== "string") {
          throw new Error("Could not inspect OpenCode v1 history identity.");
        }
        for (const name of columns) {
          const column = `"${name.replaceAll('"', '""')}"`;
          const value: unknown = db.prepare(`SELECT typeof(${column}) AS kind,
            length(CAST(${column} AS BLOB)) AS bytes FROM ${table} WHERE id = ?`).get(row.id);
          if (typeof value !== "object" || value === null || !("kind" in value) || !("bytes" in value)) {
            throw new Error("Could not inspect OpenCode v1 history content.");
          }
          const bytes = typeof value.bytes === "number" ? value.bytes : 0;
          hash.update(JSON.stringify([table, row.id, name, value.kind, bytes]));
          // Never materialize an entire large tool payload in the server heap.
          const slice = db.prepare(`SELECT substr(CAST(${column} AS BLOB), ?, ?) AS chunk FROM ${table} WHERE id = ?`);
          for (let offset = 1; offset <= bytes; offset += 512 * 1024) {
            const part: unknown = slice.get(offset, 512 * 1024, row.id);
            if (typeof part !== "object" || part === null || !("chunk" in part) || !(part.chunk instanceof Uint8Array)) {
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

interface IdleOptions {
  signal: AbortSignal;
  idle: () => Promise<boolean>;
  wait?: (signal: AbortSignal) => Promise<void>;
  idleChecks?: number;
}

export async function waitForEngineIdle(options: IdleOptions): Promise<void> {
  const wait = options.wait ?? ((signal) => new Promise<void>((resolve, reject) => {
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); resolve(); };
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason); };
    const timer = setTimeout(done, 5_000);
    timer.unref?.();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  }));
  // Waiting for idle is not a second migration attempt. Unknown activity fails closed.
  for (let check = 0; check < (options.idleChecks ?? 60); check++) {
    options.signal.throwIfAborted();
    if (await options.idle()) return;
    await wait(options.signal);
  }
  throw new Error("The selected engine is not idle. Keeping it until a later boot.");
}

export async function runEngineAutoUpgrade(options: IdleOptions & {
  revision: () => Promise<string>;
  copy: () => Promise<void>;
  switchEngine: () => Promise<void>;
}): Promise<void> {
  await waitForEngineIdle(options);
  const before = await options.revision();
  await options.copy();
  options.signal.throwIfAborted();
  if (!await options.idle() || before !== await options.revision()) {
    throw new Error("OpenCode v1 changed while chats were copied. Keeping v1 until a later boot.");
  }
  await options.switchEngine();
}
