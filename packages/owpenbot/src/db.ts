import fs from "node:fs";
import path from "node:path";

import { Database } from "bun:sqlite";

import type { ChannelName } from "./config.js";

type SessionRow = {
  channel: ChannelName;
  peer_id: string;
  session_id: string;
  directory?: string | null;
  created_at: number;
  updated_at: number;
};

type BindingRow = {
  channel: ChannelName;
  peer_id: string;
  directory: string;
  created_at: number;
  updated_at: number;
};

type AllowlistRow = {
  channel: ChannelName;
  peer_id: string;
  created_at: number;
};

type PairingRow = {
  channel: ChannelName;
  peer_id: string;
  code: string;
  created_at: number;
  expires_at: number;
};

export class BridgeStore {
  private db: Database;

  constructor(private readonly dbPath: string) {
    this.ensureDir();
    this.db = new Database(dbPath, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        channel TEXT NOT NULL,
        peer_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (channel, peer_id)
      );
      CREATE TABLE IF NOT EXISTS allowlist (
        channel TEXT NOT NULL,
        peer_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (channel, peer_id)
      );
      CREATE TABLE IF NOT EXISTS bindings (
        channel TEXT NOT NULL,
        peer_id TEXT NOT NULL,
        directory TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (channel, peer_id)
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pairing_requests (
        channel TEXT NOT NULL,
        peer_id TEXT NOT NULL,
        code TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (channel, peer_id)
      );
    `);

    this.migrate();
  }

  private migrate() {
    const columns = this.db
      .prepare("PRAGMA table_info(sessions)")
      .all() as Array<{ name?: string }>;
    const hasDirectory = columns.some((column) => column.name === "directory");
    if (!hasDirectory) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN directory TEXT");
    }
  }

  private ensureDir() {
    const dir = path.dirname(this.dbPath);
    fs.mkdirSync(dir, { recursive: true });
  }

  getSession(channel: ChannelName, peerId: string): SessionRow | null {
    const stmt = this.db.prepare(
      "SELECT channel, peer_id, session_id, directory, created_at, updated_at FROM sessions WHERE channel = ? AND peer_id = ?",
    );
    const row = stmt.get(channel, peerId) as SessionRow | null;
    return row ?? null;
  }

  upsertSession(channel: ChannelName, peerId: string, sessionId: string, directory?: string | null) {
    const now = Date.now();
    const stmt = this.db.prepare(
      `INSERT INTO sessions (channel, peer_id, session_id, directory, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(channel, peer_id) DO UPDATE SET session_id = excluded.session_id, directory = excluded.directory, updated_at = excluded.updated_at`,
    );
    stmt.run(channel, peerId, sessionId, directory ?? null, now, now);
  }

  deleteSession(channel: ChannelName, peerId: string): boolean {
    const stmt = this.db.prepare("DELETE FROM sessions WHERE channel = ? AND peer_id = ?");
    const result = stmt.run(channel, peerId);
    return result.changes > 0;
  }

  getBinding(channel: ChannelName, peerId: string): BindingRow | null {
    const stmt = this.db.prepare(
      "SELECT channel, peer_id, directory, created_at, updated_at FROM bindings WHERE channel = ? AND peer_id = ?",
    );
    const row = stmt.get(channel, peerId) as BindingRow | null;
    return row ?? null;
  }

  upsertBinding(channel: ChannelName, peerId: string, directory: string) {
    const now = Date.now();
    const stmt = this.db.prepare(
      `INSERT INTO bindings (channel, peer_id, directory, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(channel, peer_id) DO UPDATE SET directory = excluded.directory, updated_at = excluded.updated_at`,
    );
    stmt.run(channel, peerId, directory, now, now);
  }

  deleteBinding(channel: ChannelName, peerId: string): boolean {
    const stmt = this.db.prepare("DELETE FROM bindings WHERE channel = ? AND peer_id = ?");
    const result = stmt.run(channel, peerId);
    return result.changes > 0;
  }

  listBindings(channel?: ChannelName): BindingRow[] {
    if (channel) {
      const stmt = this.db.prepare(
        "SELECT channel, peer_id, directory, created_at, updated_at FROM bindings WHERE channel = ? ORDER BY updated_at DESC",
      );
      return stmt.all(channel) as BindingRow[];
    }
    const stmt = this.db.prepare(
      "SELECT channel, peer_id, directory, created_at, updated_at FROM bindings ORDER BY updated_at DESC",
    );
    return stmt.all() as BindingRow[];
  }

  isAllowed(channel: ChannelName, peerId: string): boolean {
    const stmt = this.db.prepare(
      "SELECT channel, peer_id, created_at FROM allowlist WHERE channel = ? AND peer_id = ?",
    );
    return Boolean(stmt.get(channel, peerId));
  }

  allowPeer(channel: ChannelName, peerId: string) {
    const now = Date.now();
    const stmt = this.db.prepare(
      `INSERT INTO allowlist (channel, peer_id, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT(channel, peer_id) DO UPDATE SET created_at = excluded.created_at`,
    );
    stmt.run(channel, peerId, now);
  }

  seedAllowlist(channel: ChannelName, peers: Iterable<string>) {
    const insert = this.db.prepare(
      `INSERT INTO allowlist (channel, peer_id, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT(channel, peer_id) DO NOTHING`,
    );
    const now = Date.now();
    const transaction = this.db.transaction(() => {
      for (const peer of peers) {
        insert.run(channel, peer, now);
      }
    });
    transaction();
  }

  listPairingRequests(channel?: ChannelName): PairingRow[] {
    const now = Date.now();
    if (channel) {
      const stmt = this.db.prepare(
        "SELECT channel, peer_id, code, created_at, expires_at FROM pairing_requests WHERE channel = ? AND expires_at > ? ORDER BY created_at ASC",
      );
      return stmt.all(channel, now) as PairingRow[];
    }
    const stmt = this.db.prepare(
      "SELECT channel, peer_id, code, created_at, expires_at FROM pairing_requests WHERE expires_at > ? ORDER BY created_at ASC",
    );
    return stmt.all(now) as PairingRow[];
  }

  getPairingRequest(channel: ChannelName, peerId: string): PairingRow | null {
    const now = Date.now();
    const stmt = this.db.prepare(
      "SELECT channel, peer_id, code, created_at, expires_at FROM pairing_requests WHERE channel = ? AND peer_id = ? AND expires_at > ?",
    );
    const row = stmt.get(channel, peerId, now) as PairingRow | null;
    return row ?? null;
  }

  createPairingRequest(channel: ChannelName, peerId: string, code: string, ttlMs: number) {
    const now = Date.now();
    const expiresAt = now + ttlMs;
    const stmt = this.db.prepare(
      `INSERT INTO pairing_requests (channel, peer_id, code, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(channel, peer_id) DO UPDATE SET code = excluded.code, created_at = excluded.created_at, expires_at = excluded.expires_at`,
    );
    stmt.run(channel, peerId, code, now, expiresAt);
  }

  approvePairingRequest(channel: ChannelName, code: string): PairingRow | null {
    const now = Date.now();
    const select = this.db.prepare(
      "SELECT channel, peer_id, code, created_at, expires_at FROM pairing_requests WHERE channel = ? AND code = ? AND expires_at > ?",
    );
    const row = select.get(channel, code, now) as PairingRow | null;
    if (!row) return null;
    const del = this.db.prepare("DELETE FROM pairing_requests WHERE channel = ? AND peer_id = ?");
    del.run(channel, row.peer_id);
    return row;
  }

  denyPairingRequest(channel: ChannelName, code: string): boolean {
    const stmt = this.db.prepare("DELETE FROM pairing_requests WHERE channel = ? AND code = ?");
    const result = stmt.run(channel, code);
    return result.changes > 0;
  }

  prunePairingRequests() {
    const now = Date.now();
    const stmt = this.db.prepare("DELETE FROM pairing_requests WHERE expires_at <= ?");
    stmt.run(now);
  }

  getSetting(key: string): string | null {
    const stmt = this.db.prepare("SELECT value FROM settings WHERE key = ?");
    const row = stmt.get(key) as { value?: string } | null;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string) {
    const stmt = this.db.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    stmt.run(key, value);
  }

  close() {
    this.db.close();
  }
}
