import { randomBytes } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import { Database } from "bun:sqlite";

type SeedMessage = {
  role: "assistant" | "user";
  text: string;
};

const DEFAULT_AGENT = "openwork";
const DEFAULT_PROVIDER = "openai";
const DEFAULT_MODEL = "gpt-5.4";
const OPENWORK_DEV_DATA_DIRS = ["openwork-dev-data", "opencode-dev"];

function truthy(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function opencodeOrchestratorDataDirs(): string[] {
  const root = process.env.OPENWORK_DATA_DIR?.trim();
  if (!root) return [];

  const dirs: string[] = [];
  const pushIfExists = (dir: string) => {
    if (existsSync(dir)) dirs.push(dir);
  };

  for (const name of OPENWORK_DEV_DATA_DIRS) {
    const base = join(root, name);
    pushIfExists(join(base, "xdg", "data", "opencode"));
    if (!existsSync(base)) continue;

    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      pushIfExists(join(base, entry.name, "xdg", "data", "opencode"));
    }
  }

  return dirs;
}

function opencodeDataDirs(): string[] {
  const dirs: string[] = [];
  dirs.push(...opencodeOrchestratorDataDirs());
  const xdg = process.env.XDG_DATA_HOME?.trim();
  if (xdg) dirs.push(join(xdg, "opencode"));
  dirs.push(join(homedir(), ".local", "share", "opencode"));
  if (process.platform === "darwin") dirs.push(join(homedir(), "Library", "Application Support", "opencode"));
  if (process.platform === "win32") {
    const appData = process.env.APPDATA?.trim();
    if (appData) dirs.push(join(appData, "opencode"));
  }
  return Array.from(new Set(dirs));
}

function preferredDbNames(): string[] {
  const channel = process.env.OPENCODE_CHANNEL?.trim() || "local";
  return channel === "latest" || channel === "beta" || truthy(process.env.OPENCODE_DISABLE_CHANNEL_DB)
    ? ["opencode.db"]
    : [`opencode-${channel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`, "opencode.db"];
}

function candidateOpencodeDbPaths(): string[] {
  const override = process.env.OPENCODE_DB?.trim();
  if (override) {
    if (isAbsolute(override)) return [override];
    const candidates: string[] = [];
    for (const dir of opencodeDataDirs()) {
      candidates.push(join(dir, override));
    }
    candidates.push(join(opencodeDataDirs()[0] ?? join(homedir(), ".local", "share", "opencode"), override));
    return Array.from(new Set(candidates));
  }

  const candidates: string[] = [];
  for (const dir of opencodeDataDirs()) {
    for (const name of preferredDbNames()) {
      candidates.push(join(dir, name));
    }
  }

  return Array.from(new Set(candidates));
}

export function resolveOpencodeDbPath(): string {
  const candidates = candidateOpencodeDbPaths();
  const existing = candidates.find((candidate) => existsSync(candidate));
  if (existing) return existing;
  return candidates[0] ?? join(homedir(), ".local", "share", "opencode", preferredDbNames()[0] ?? "opencode.db");
}

function findOpencodeSessionDbPath(sessionId: string, inputPath?: string): string | null {
  const candidates = (inputPath ? [inputPath] : candidateOpencodeDbPaths()).filter((candidate) => existsSync(candidate));
  for (const dbPath of candidates) {
    const db = new Database(dbPath, { readonly: true });
    try {
      const session = db.query("select id from session where id = ?1").get(sessionId);
      if (session) return dbPath;
    } catch {
      // ignore non-matching dbs
    } finally {
      db.close();
    }
  }
  return null;
}

function randomBase62(length: number): string {
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const bytes = randomBytes(length);
  let output = "";
  for (let index = 0; index < length; index += 1) {
    output += chars[bytes[index]! % 62];
  }
  return output;
}

function ascendingId(prefix: "msg" | "prt", timestamp: number, counter: number): string {
  const now = BigInt(timestamp) * 0x1000n + BigInt(counter);
  const bytes = Buffer.alloc(6);
  for (let index = 0; index < 6; index += 1) {
    bytes[index] = Number((now >> BigInt(40 - 8 * index)) & 0xffn);
  }
  return `${prefix}_${bytes.toString("hex")}${randomBase62(14)}`;
}

export function seedOpencodeSessionMessages(input: {
  sessionId: string;
  workspaceRoot: string;
  messages: SeedMessage[];
  dbPath?: string;
  now?: number;
}): { inserted: number; skipped: boolean } {
  const sessionId = input.sessionId.trim();
  if (!sessionId) {
    throw new Error("sessionId is required");
  }

  const messages = input.messages.filter((item) => item.text.trim());
  if (!messages.length) {
    return { inserted: 0, skipped: true };
  }

  const explicitDbPath = input.dbPath?.trim() || undefined;
  const dbPath = findOpencodeSessionDbPath(sessionId, explicitDbPath) || explicitDbPath || resolveOpencodeDbPath();
  if (!existsSync(dbPath)) {
    throw new Error(`OpenCode database not found at ${dbPath}`);
  }

  const db = new Database(dbPath);
  db.exec("PRAGMA foreign_keys = ON");

  try {
    const run = db.transaction(() => {
      const session = db.query("select id from session where id = ?1").get(sessionId);
      if (!session) {
        throw new Error(`OpenCode session not found: ${sessionId}`);
      }

      const existing = db.query("select count(1) as count from message where session_id = ?1").get(sessionId) as { count?: number } | null;
      if ((existing?.count ?? 0) > 0) {
        return { inserted: 0, skipped: true };
      }

      const insertMessage = db.prepare(
        "insert into message (id, session_id, time_created, time_updated, data) values (?1, ?2, ?3, ?4, ?5)",
      );
      const insertPart = db.prepare(
        "insert into part (id, message_id, session_id, time_created, time_updated, data) values (?1, ?2, ?3, ?4, ?5, ?6)",
      );
      const updateSession = db.prepare("update session set time_updated = ?2 where id = ?1");

      const startedAt = input.now ?? Date.now();
      let counter = 0;
      let lastUserId: string | null = null;

      messages.forEach((item, index) => {
        const createdAt = startedAt + index;
        counter += 1;
        const messageId = ascendingId("msg", createdAt, counter);
        counter += 1;
        const partId = ascendingId("prt", createdAt, counter);

        const messageData =
          item.role === "user"
            ? {
                role: "user",
                time: { created: createdAt },
                summary: { diffs: [] },
                agent: DEFAULT_AGENT,
                model: { providerID: DEFAULT_PROVIDER, modelID: DEFAULT_MODEL },
              }
            : {
                role: "assistant",
                time: { created: createdAt, completed: createdAt },
                parentID: lastUserId ?? messageId,
                modelID: DEFAULT_MODEL,
                providerID: DEFAULT_PROVIDER,
                mode: DEFAULT_AGENT,
                agent: DEFAULT_AGENT,
                path: { cwd: input.workspaceRoot, root: input.workspaceRoot },
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              };

        insertMessage.run(messageId, sessionId, createdAt, createdAt, JSON.stringify(messageData));
        insertPart.run(
          partId,
          messageId,
          sessionId,
          createdAt,
          createdAt,
          JSON.stringify({ type: "text", text: item.text.trim() }),
        );

        if (item.role === "user") {
          lastUserId = messageId;
        }
      });

      updateSession.run(sessionId, startedAt + messages.length);
      return { inserted: messages.length, skipped: false };
    });

    return run();
  } finally {
    db.close();
  }
}
