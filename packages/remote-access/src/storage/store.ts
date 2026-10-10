import { open, mkdir, lstat, readFile, rename, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  BridgeError,
  record,
  type MutationReceipt,
} from "../contract/index.js";
export interface Device {
  id: string;
  deviceId: string;
  name: string;
  tokenHash: string;
  workspaceIds: string[];
  allWorkspaces?: boolean;
  active: boolean;
  revoked: boolean;
}
export interface LedgerRecord {
  deviceId: string;
  hash: string;
  route: string;
  createdAt: string;
  receipt: MutationReceipt;
}
export interface State {
  schemaVersion: 1;
  hostId: string;
  displayName: string;
  devices: Device[];
  ledger: Record<string, LedgerRecord>;
}
function valid(s: unknown): s is State {
  if (
    !record(s) ||
    s.schemaVersion !== 1 ||
    typeof s.hostId !== "string" ||
    !/^[0-9a-f-]{36}$/.test(s.hostId) ||
    typeof s.displayName !== "string" ||
    !Array.isArray(s.devices) ||
    !record(s.ledger)
  )
    return false;
  if (s.devices.length > 1000) return false;
  return (
    s.devices.every(
      (d) =>
        record(d) &&
        typeof d.id === "string" &&
        typeof d.deviceId === "string" &&
        typeof d.name === "string" &&
        typeof d.tokenHash === "string" &&
        /^[0-9a-f]{64}$/.test(d.tokenHash) &&
        Array.isArray(d.workspaceIds) &&
        d.workspaceIds.length <= 100 &&
        d.workspaceIds.every(
          (w: unknown) =>
            typeof w === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(w),
        ) &&
        (d.allWorkspaces === undefined ||
          typeof d.allWorkspaces === "boolean") &&
        typeof d.active === "boolean" &&
        typeof d.revoked === "boolean",
    ) &&
    Object.values(s.ledger).every(
      (v) =>
        record(v) &&
        typeof v.deviceId === "string" &&
        typeof v.hash === "string" &&
        /^[0-9a-f]{64}$/.test(v.hash) &&
        typeof v.route === "string" &&
        typeof v.createdAt === "string" &&
        record(v.receipt) &&
        typeof v.receipt.requestId === "string" &&
        [
          "pending",
          "accepted",
          "confirmed",
          "rejected",
          "outcome_unknown",
        ].includes(String(v.receipt.state)),
    )
  );
}
async function privatePath(path: string, directory = false) {
  const s = await lstat(path);
  if (
    s.isSymbolicLink() ||
    s.uid !== process.getuid?.() ||
    (directory ? !s.isDirectory() : !s.isFile()) ||
    (s.mode & 0o777) !== (directory ? 0o700 : 0o600)
  )
    throw new BridgeError("UNSAFE_PERMISSIONS");
  return s;
}
export class Store {
  private queue: Promise<unknown> = Promise.resolve();
  private failed = false;
  private closed = false;
  private constructor(
    private root: string,
    private data: State,
    private lock: FileHandle,
  ) {}
  get snapshot(): State {
    return structuredClone(this.data);
  }
  static async read(root: string): Promise<State | null> {
    try {
      await privatePath(root, true);
      const path = join(root, "state.json"),
        info = await privatePath(path);
      if (info.size > 32 * 1024 * 1024) throw new BridgeError("INVALID_STORE");
      const state: unknown = JSON.parse(await readFile(path, "utf8"));
      if (!valid(state)) throw new BridgeError("INVALID_STORE");
      return state;
    } catch (e) {
      if (e && typeof e === "object" && "code" in e && e.code === "ENOENT")
        return null;
      throw e instanceof BridgeError ? e : new BridgeError("INVALID_STORE");
    }
  }
  static async open(root: string) {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await privatePath(root, true);
    const lockPath = join(root, "lock");
    let lock: FileHandle;
    try {
      lock = await open(lockPath, "wx", 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const old = await privatePath(lockPath);
      const pid = Number(await readFile(lockPath, "utf8"));
      if (!Number.isSafeInteger(pid) || pid < 1)
        throw new BridgeError("STORE_LOCKED");
      let dead = false;
      try {
        process.kill(pid, 0);
      } catch (e) {
        dead = (e as NodeJS.ErrnoException).code === "ESRCH";
      }
      if (!dead) throw new BridgeError("STORE_LOCKED");
      if ((await lstat(lockPath)).ino !== old.ino)
        throw new BridgeError("STORE_LOCKED");
      await unlink(lockPath);
      lock = await open(lockPath, "wx", 0o600);
    }
    try {
      await lock.writeFile(String(process.pid));
      await lock.sync();
      let state: State;
      try {
        await privatePath(join(root, "state.json"));
        state = JSON.parse(await readFile(join(root, "state.json"), "utf8"));
        if (!valid(state)) throw new BridgeError("INVALID_STORE");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT")
          state = {
            schemaVersion: 1,
            hostId: randomUUID(),
            displayName: "My computer",
            devices: [],
            ledger: {},
          };
        else
          throw e instanceof BridgeError ? e : new BridgeError("INVALID_STORE");
      }
      const store = new Store(root, state, lock);
      await store.update((s) => {
        for (const d of s.devices) if (!d.active) d.revoked = true;
        for (const r of Object.values(s.ledger))
          if (r.receipt.state === "pending")
            r.receipt = {
              ...r.receipt,
              state: "outcome_unknown",
              observedAt: new Date().toISOString(),
            };
      });
      return store;
    } catch (e) {
      await lock.close();
      await unlink(lockPath);
      throw e;
    }
  }
  update<T>(mutate: (state: State) => T): Promise<T> {
    const work = this.queue.then(async () => {
      if (this.failed || this.closed)
        throw new BridgeError("STORE_UNAVAILABLE");
      const next = structuredClone(this.data),
        result = mutate(next);
      if (!valid(next)) throw new BridgeError("INVALID_STORE");
      const path = join(this.root, `state-${randomUUID()}.tmp`);
      let f: FileHandle | undefined;
      try {
        f = await open(path, "wx", 0o600);
        await f.writeFile(JSON.stringify(next));
        await f.sync();
        await f.close();
        f = undefined;
        await rename(path, join(this.root, "state.json"));
        const directory = await open(this.root, "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
        this.data = next;
        return result;
      } catch {
        this.failed = true;
        await f?.close().catch(() => {});
        await unlink(path).catch(() => {});
        throw new BridgeError("STORE_UNAVAILABLE");
      }
    });
    this.queue = work.catch(() => {});
    return work;
  }
  async close() {
    await this.queue;
    this.closed = true;
    await this.lock.close();
    await unlink(join(this.root, "lock"));
  }
}
