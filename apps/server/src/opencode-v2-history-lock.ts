import { randomBytes } from "node:crypto";
import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { openHistoryDatabase } from "./opencode-v2-history-store.js";

const PENDING = "history-copy.pending";
const LEASE = "engine-lease-";

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return false; throw error; }
}

function alive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return !(error instanceof Error && "code" in error && error.code === "ESRCH"); }
}

async function owner(path: string): Promise<{ pid?: unknown; child?: unknown }> {
  const data: unknown = JSON.parse(await readFile(path, "utf8"));
  if (typeof data !== "object" || data === null) throw new Error("An engine ownership record is unreadable; its history was preserved.");
  return { pid: "pid" in data ? data.pid : undefined, child: "child" in data ? data.child : undefined };
}

/** SQLite's OS lock is released even on SIGKILL. Avoid PID lock-file stealing,
 * which races two processes trying to recover the same abandoned owner. */
async function exclusive(root: string) {
  const db = await openHistoryDatabase(join(root, "history-copy-mutex.db"));
  try {
    db.exec("PRAGMA busy_timeout = 0; CREATE TABLE IF NOT EXISTS ownership (id INTEGER PRIMARY KEY); BEGIN EXCLUSIVE");
    return db;
  } catch { db.close(); throw new Error("Another history copy is using this database. Wait for it to finish."); }
}

/** Cooperative ownership across installed/dev app instances sharing one DB.
 * The durable pending fence survives failure; the OS mutex survives no process. */
export async function acquireHistoryCopyLock(database: string) {
  const root = dirname(database);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const mutex = await exclusive(root);
  try {
    // Publish the fence before inspecting leases. A racing startup either
    // publishes its lease first (seen here), or sees this fence and closes.
    await writeFile(join(root, PENDING), "History copy must finish before the engine opens this database.\n", { mode: 0o600 });
    for (const name of await readdir(root)) {
      if (!name.startsWith(LEASE)) continue;
      const leasePath = join(root, name);
      let previous: { pid?: unknown; child?: unknown };
      try { previous = await owner(leasePath); }
      catch (error) { if (!await exists(leasePath)) continue; throw error; }
      if (alive(previous.pid) || alive(previous.child)) throw new Error("Another OpenCode v2 engine is using this history. Close it before retrying migration.");
      await rm(leasePath);
    }
  } catch (error) { mutex.close(); throw error; }
  return {
    async complete() { await rm(join(root, PENDING), { force: true }); },
    async release() { mutex.close(); },
  };
}

export async function acquireEngineHistoryLease(root: string) {
  const check = async () => {
    if (await exists(join(root, PENDING))) throw new Error("History migration is incomplete. Resume it before opening OpenCode v2.");
  };
  await check();
  const path = join(root, `${LEASE}${process.pid}-${randomBytes(12).toString("hex")}.json`);
  const mutex = await exclusive(root);
  try {
    await check();
    await writeFile(path, JSON.stringify({ pid: process.pid }), { flag: "wx", mode: 0o600 });
  } finally { mutex.close(); }
  return {
    async child(pid: number | undefined) { await writeFile(path, JSON.stringify({ pid: process.pid, child: pid }), { mode: 0o600 }); },
    async release() { await rm(path, { force: true }); },
  };
}
