import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";

import {
  CodeSessionsError,
  type CodeSessionDetail,
  type CodeSessionSummary,
} from "./types.js";
import { isRecord, str } from "./records.js";

/**
 * OpenCode v2 adapter for the Code tab.
 *
 * OpenCode v2 keeps every session in one SQLite database
 * (`<data>/opencode.db`: `session`, `message`, `part` tables where message
 * and part payloads are JSON in a `data` column). The adapter opens the
 * database read-only with a short busy timeout so a running TUI or engine
 * keeps writing undisturbed, and transcodes rows into the neutral shape:
 *
 * - message.data.role: "user" | "assistant" (others skipped)
 * - part.data.type: "text" → text, "reasoning" → reasoning,
 *   "tool" → tool call with state.input/output/error, everything else
 *   (step-start, file diffs, …) is bookkeeping and skipped.
 *
 * Nothing here writes to the database: the connection is read-only.
 */

const OPENCODE_LIMITS = {
  /** Sessions scanned per list pass. */
  maxSessions: 2_000,
  /** Transcripts above this size (approximated by part bytes) are skipped. */
  maxSessionBytes: 256 * 1024 * 1024,
} as const;

export function defaultOpenCodeDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const dataHome = env.OPENCODE_DATA_HOME?.trim()
    || (env.XDG_DATA_HOME?.trim() ? join(env.XDG_DATA_HOME.trim(), "opencode") : "");
  return dataHome || join(homedir(), ".local", "share", "opencode", "opencode.db");
}

/** Sessions are globally unique (`ses_…`), so the id needs no path scoping. */
function assertSessionId(id: string): string {
  if (!id || id.includes("/") || id.includes("\\") || !id.startsWith("ses_")) {
    throw new CodeSessionsError("code_session_not_found", "This OpenCode session id is not valid.");
  }
  return id;
}

function openReadOnly(path: string): Database.Database {
  return new Database(path, { readonly: true, fileMustExist: true });
}

export type OpenCodeListOptions = {
  dbPath?: string;
};

export async function listOpenCodeSessionsEverywhere(
  options: OpenCodeListOptions = {},
): Promise<CodeSessionSummary[]> {
  const dbPath = options.dbPath ?? defaultOpenCodeDbPath();
  try {
    const info = await stat(dbPath);
    if (!info.isFile()) return [];
  } catch {
    // No OpenCode v2 data on this machine is an empty list, not an error.
    return [];
  }

  const db = openReadOnly(dbPath);
  try {
    const rows = db
      .prepare(
        "SELECT id, directory, title, time_created, time_updated FROM session ORDER BY time_updated DESC LIMIT ?",
      )
      .all(OPENCODE_LIMITS.maxSessions) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      client: "opencode" as const,
      sessionId: String(row.id ?? ""),
      projectPath: String(row.directory ?? "").replace(/\//g, "\\"),
      title: String(row.title ?? "OpenCode session"),
      startedAt: Number(row.time_created ?? 0),
      updatedAt: Number(row.time_updated ?? 0),
      messageCount: -1,
      sizeBytes: 0,
    })).filter((item) => item.sessionId.startsWith("ses_"));
  } catch {
    // A locked or unreadable database is surfaced as an empty mirror rather
    // than an error page: the next poll retries.
    return [];
  } finally {
    db.close();
  }
}

export type OpenCodeReadOptions = {
  dbPath?: string;
};

/** What driving needs from a session: confirmation it exists and its project directory. */
export async function opencodeDriveContext(
  sessionId: string,
  options: OpenCodeReadOptions = {},
): Promise<{ directory: string }> {
  const dbPath = options.dbPath ?? defaultOpenCodeDbPath();
  const cleanId = assertSessionId(sessionId);
  let db: Database.Database;
  try {
    db = openReadOnly(dbPath);
  } catch {
    throw new CodeSessionsError("code_session_not_found", "The OpenCode database is gone or cannot be read.");
  }
  try {
    const row = db
      .prepare("SELECT directory FROM session WHERE id = ?")
      .get(cleanId) as { directory?: unknown } | undefined;
    const directory = str(row?.directory);
    if (!directory) {
      throw new CodeSessionsError("code_session_not_found", "This OpenCode session is gone or cannot be read.");
    }
    return { directory };
  } finally {
    db.close();
  }
}

export async function readOpenCodeSessionEverywhere(
  id: string,
  options: OpenCodeReadOptions = {},
): Promise<CodeSessionDetail> {
  const sessionId = assertSessionId(id);
  const dbPath = options.dbPath ?? defaultOpenCodeDbPath();

  let db: Database.Database;
  try {
    db = openReadOnly(dbPath);
  } catch {
    throw new CodeSessionsError("code_session_not_found", "The OpenCode database is gone or cannot be read.");
  }

  type Block =
    | { type: "text"; text: string }
    | { type: "reasoning"; text: string }
    | { type: "tool"; call: { id: string; name: string; input: Record<string, unknown>; output: string; failed: boolean; time: number } };

  try {
    const session = db
      .prepare("SELECT id, directory, title, time_created, time_updated FROM session WHERE id = ?")
      .get(sessionId) as Record<string, unknown> | undefined;
    if (!session) {
      throw new CodeSessionsError("code_session_not_found", "This OpenCode session is gone or cannot be read.");
    }

    const messages = db
      .prepare("SELECT id, time_created, time_updated, data FROM message WHERE session_id = ? ORDER BY time_created ASC")
      .all(sessionId) as Array<{ id: string; time_created: number; time_updated: number; data: string }>;

    const partsByMessage = new Map<string, Array<{ time: number; data: Record<string, unknown> }>>();
    for (const part of db
      .prepare("SELECT message_id, time_created, data FROM part WHERE session_id = ? ORDER BY time_created ASC")
      .all(sessionId) as Array<{ message_id: string; time_created: number; data: string }>) {
      try {
        const data: unknown = JSON.parse(part.data);
        if (!isRecord(data)) continue;
        const list = partsByMessage.get(part.message_id) ?? [];
        list.push({ time: part.time_created, data });
        partsByMessage.set(part.message_id, list);
      } catch {
        // A part row with malformed JSON is bookkeeping damage; skip it.
      }
    }

    const messages_out: CodeSessionDetail["messages"] = [];
    for (const row of messages) {
      let meta: unknown;
      try { meta = JSON.parse(row.data); } catch { continue; }
      if (!isRecord(meta)) continue;
      const role = str(meta.role);
      if (role !== "user" && role !== "assistant") continue;
      const parts = partsByMessage.get(row.id) ?? [];
      const blocks: Block[] = [];
      let userText = "";
      for (const part of parts) {
        const type = str(part.data.type);
        if (type === "text" && typeof part.data.text === "string") {
          if (role === "user") userText = userText ? `${userText}\n${part.data.text}` : part.data.text;
          else blocks.push({ type: "text", text: part.data.text });
          continue;
        }
        if (role !== "assistant") continue;
        if (type === "reasoning" && typeof part.data.text === "string" && part.data.text) {
          blocks.push({ type: "reasoning", text: part.data.text });
          continue;
        }
        if (type === "tool" && typeof part.data.tool === "string" && isRecord(part.data.state)) {
          const state = part.data.state;
          const time = isRecord(state.time) && typeof state.time.start === "number" ? state.time.start : part.time;
          const output = typeof state.output === "string"
            ? state.output
            : isRecord(state.output) || Array.isArray(state.output)
              ? JSON.stringify(state.output)
              : "";
          blocks.push({
            type: "tool",
            call: {
              id: str(part.data.callID) ?? String(row.id),
              name: String(part.data.tool),
              input: isRecord(state.input) ? state.input : {},
              output,
              failed: state.status === "error",
              time,
            },
          });
        }
      }
      if (role === "user") {
        if (!userText.trim()) continue;
        messages_out.push({ role: "user", sourceId: row.id, time: row.time_created, text: userText });
        continue;
      }
      if (blocks.length === 0) continue;
      const completed = Number(row.time_updated ?? row.time_created);
      const previous = messages_out[messages_out.length - 1];
      if (previous?.role === "assistant") {
        previous.blocks.push(...blocks);
        previous.completed = Math.max(previous.completed, completed);
        continue;
      }
      messages_out.push({ role: "assistant", sourceId: row.id, time: row.time_created, completed, blocks });
    }

    if (messages_out.length === 0) {
      throw new CodeSessionsError("code_session_unreadable", "This OpenCode session has no readable messages.");
    }

    return {
      summary: {
        client: "opencode",
        sessionId,
        projectPath: String(session.directory ?? "").replace(/\//g, "\\"),
        title: String(session.title ?? "OpenCode session"),
        startedAt: Number(session.time_created ?? 0),
        updatedAt: Number(session.time_updated ?? 0),
        messageCount: messages_out.length,
        sizeBytes: 0,
      },
      messages: messages_out,
      notes: [],
      sourceHash: "",
    };
  } finally {
    db.close();
  }
}
