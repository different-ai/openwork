import { chmod, mkdir, readFile, rename, rm, writeFile, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { platform } from "node:os";

import {
  appAuditEntrySchema,
  installedAppRecordSchema,
  type AppAuditEntry,
  type AppLifecycleEvent,
  type InstalledAppRecord,
} from "@openwork/app-contract";

import { auditLogPath, installedRegistryPath } from "./paths.js";

// The installed-app registry.
//
// Persistence follows the same discipline as the environment store: atomic
// temp-file-then-rename writes with restrictive permissions, and a serialised
// mutation queue so concurrent installs cannot interleave into a half-written
// registry.
//
// A record that fails its schema on load is dropped rather than trusted. A
// corrupted registry entry must not become a runnable app with unverifiable
// permissions.

type RegistryFile = { schemaVersion: 1; updatedAt: number; apps: InstalledAppRecord[] };

export class InstalledAppStore {
  readonly #path: string;
  readonly #auditPath: string;
  #loaded = false;
  #loadPromise: Promise<void> | null = null;
  #mutations: Promise<unknown> = Promise.resolve();
  #apps = new Map<string, InstalledAppRecord>();
  /** Records dropped on load because they failed validation, for diagnostics. */
  #rejected: string[] = [];

  constructor(options: { dataDir?: string } = {}) {
    this.#path = installedRegistryPath(options.dataDir);
    this.#auditPath = auditLogPath(options.dataDir);
  }

  get rejectedOnLoad(): readonly string[] {
    return this.#rejected;
  }

  async #ensureLoaded(): Promise<void> {
    if (this.#loaded) return;
    if (!this.#loadPromise) {
      this.#loadPromise = this.#load().finally(() => {
        this.#loadPromise = null;
      });
    }
    await this.#loadPromise;
  }

  async #load(): Promise<void> {
    this.#apps = new Map();
    this.#rejected = [];
    const raw = await readFile(this.#path, "utf8").catch(() => null);
    if (raw !== null) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
      const apps =
        parsed && typeof parsed === "object" && Array.isArray((parsed as RegistryFile).apps)
          ? (parsed as RegistryFile).apps
          : [];
      for (const entry of apps) {
        const result = installedAppRecordSchema.safeParse(entry);
        if (!result.success) {
          const id =
            entry && typeof entry === "object" && typeof (entry as { app_id?: unknown }).app_id === "string"
              ? (entry as { app_id: string }).app_id
              : "<unreadable>";
          this.#rejected.push(id);
          continue;
        }
        this.#apps.set(result.data.app_id, result.data);
      }
    }
    this.#loaded = true;
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#mutations.catch(() => {}).then(operation);
    this.#mutations = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  async #persist(): Promise<void> {
    const payload: RegistryFile = {
      schemaVersion: 1,
      updatedAt: Date.now(),
      apps: [...this.#apps.values()].sort((a, b) => a.app_id.localeCompare(b.app_id)),
    };
    const directory = dirname(this.#path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(
      directory,
      `.installed.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
    );
    await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    try {
      await rename(temporary, this.#path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
    if (platform() !== "win32") await chmod(this.#path, 0o600).catch(() => {});
  }

  async list(): Promise<InstalledAppRecord[]> {
    await this.#ensureLoaded();
    return [...this.#apps.values()];
  }

  async get(appId: string): Promise<InstalledAppRecord | null> {
    await this.#ensureLoaded();
    return this.#apps.get(appId) ?? null;
  }

  async put(record: InstalledAppRecord): Promise<InstalledAppRecord> {
    return this.#enqueue(async () => {
      await this.#ensureLoaded();
      const validated = installedAppRecordSchema.parse(record);
      this.#apps.set(validated.app_id, validated);
      await this.#persist();
      return validated;
    });
  }

  /**
   * Read-modify-write under the mutation lock.
   *
   * Callers must use this rather than get-then-put: an enable racing an update
   * would otherwise write back a stale record and silently undo the other.
   */
  async update(
    appId: string,
    mutate: (record: InstalledAppRecord) => InstalledAppRecord,
  ): Promise<InstalledAppRecord | null> {
    return this.#enqueue(async () => {
      await this.#ensureLoaded();
      const current = this.#apps.get(appId);
      if (!current) return null;
      const next = installedAppRecordSchema.parse(mutate({ ...current }));
      if (next.app_id !== appId) {
        throw new Error("an update may not change the app id");
      }
      this.#apps.set(appId, next);
      await this.#persist();
      return next;
    });
  }

  async remove(appId: string): Promise<boolean> {
    return this.#enqueue(async () => {
      await this.#ensureLoaded();
      if (!this.#apps.delete(appId)) return false;
      await this.#persist();
      return true;
    });
  }

  /**
   * Append one audit row.
   *
   * Append-only and line-delimited so a crash mid-write loses at most the last
   * row. Rows never carry secret values, transcript bodies, or provider
   * payloads — the schema has nowhere to put them.
   */
  async audit(entry: {
    appId: string;
    appVersion: string;
    event: AppLifecycleEvent;
    subject?: string;
    reason?: string;
  }): Promise<AppAuditEntry> {
    const row = appAuditEntrySchema.parse({
      at: Date.now(),
      app_id: entry.appId,
      app_version: entry.appVersion,
      event: entry.event,
      ...(entry.subject === undefined ? {} : { subject: entry.subject }),
      ...(entry.reason === undefined ? {} : { reason: entry.reason }),
    });
    await mkdir(dirname(this.#auditPath), { recursive: true, mode: 0o700 });
    await appendFile(this.#auditPath, `${JSON.stringify(row)}\n`, { encoding: "utf8", mode: 0o600 });
    return row;
  }

  /** Most recent audit rows, newest first. */
  async auditHistory(limit = 100, appId?: string): Promise<AppAuditEntry[]> {
    const raw = await readFile(this.#auditPath, "utf8").catch(() => "");
    const rows: AppAuditEntry[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const result = appAuditEntrySchema.safeParse(parsed);
      if (!result.success) continue;
      if (appId && result.data.app_id !== appId) continue;
      rows.push(result.data);
    }
    return rows.slice(-Math.max(1, limit)).reverse();
  }
}
