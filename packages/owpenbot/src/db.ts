import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import type { ChannelName } from "./config.js";

type SessionRow = {
  channel: ChannelName;
  peer_id: string;
  session_id: string;
  created_at: number;
  updated_at: number;
};

type AllowlistRow = {
  channel: ChannelName;
  peer_id: string;
  created_at: number;
};

export class BridgeStore {
  private db: Database.Database;

  constructor(private readonly dbPath: string) {
    this.ensureDir();
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
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
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  private ensureDir() {
    const dir = path.dirname(this.dbPath);
    fs.mkdirSync(dir, { recursive: true });
  }

  getSession(channel: ChannelName, peerId: string): SessionRow | null {
    const stmt = this.db.prepare(
      "SELECT channel, peer_id, session_id, created_at, updated_at FROM sessions WHERE channel = ? AND peer_id = ?",
    );
    const row = stmt.get(channel, peerId) as SessionRow | undefined;
    return row ?? null;
  }

  upsertSession(channel: ChannelName, peerId: string, sessionId: string) {
    const now = Date.now();
    const stmt = this.db.prepare(
      `INSERT INTO sessions (channel, peer_id, session_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(channel, peer_id) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at`,
    );
    stmt.run(channel, peerId, sessionId, now, now);
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
    const transaction = this.db.transaction((items: Iterable<string>) => {
      for (const peer of items) {
        insert.run(channel, peer, now);
      }
    });
    transaction(peers);
  }

  getSetting(key: string): string | null {
    const stmt = this.db.prepare("SELECT value FROM settings WHERE key = ?");
    const row = stmt.get(key) as { value?: string } | undefined;
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
