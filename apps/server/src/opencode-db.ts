import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import { Database } from "bun:sqlite";

type SeedMessage = {
  role: "assistant" | "user";
  text: string;
};

function truthy(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function opencodeDataDir(): string {
  const xdg = process.env.XDG_DATA_HOME?.trim();
  if (xdg) return join(xdg, "opencode");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "opencode");
  if (process.platform === "win32") {
    const appData = process.env.APPDATA?.trim();
    if (appData) return join(appData, "opencode");
  }
  return join(homedir(), ".local", "share", "opencode");
}

export function resolveOpencodeDbPath(): string {
  const override = process.env.OPENCODE_DB?.trim();
  if (override) return isAbsolute(override) ? override : join(opencodeDataDir(), override);

  const channel = process.env.OPENCODE_CHANNEL?.trim() || "local";
  if (channel === "latest" || channel === "beta" || truthy(process.env.OPENCODE_DISABLE_CHANNEL_DB)) {
    return join(opencodeDataDir(), "opencode.db");
  }

  return join(opencodeDataDir(), `opencode-${channel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`);
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

  const dbPath = input.dbPath?.trim() || resolveOpencodeDbPath();
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
                agent: "",
                model: { providerID: "", modelID: "" },
              }
            : {
                role: "assistant",
                time: { created: createdAt, completed: createdAt },
                parentID: lastUserId ?? messageId,
                modelID: "",
                providerID: "",
                mode: "",
                agent: "",
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
          JSON.stringify({ type: "text", text: item.text.trim(), synthetic: true, time: { start: createdAt, end: createdAt } }),
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
