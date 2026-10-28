import { open, readFile, readdir, stat } from "node:fs/promises";
import { join, resolve as resolvePath, sep } from "node:path";

import {
  CLAUDE_IMPORT_LIMITS,
  claudeConfigDir,
  readClaudeCodeTranscript,
} from "../claude-import.js";
import {
  CodeSessionsError,
  type CodeSessionDetail,
  type CodeSessionSummary,
} from "./types.js";

/**
 * Claude Code adapter for the Code tab.
 *
 * Claude Code stores every project's sessions under
 * `<config>/projects/<encoded-folder>/<session-id>.jsonl`, appending one JSON
 * record per line while the session runs. The folder name replaces every
 * non-alphanumeric character with a dash, so it cannot be decoded back to the
 * project path; the real path is taken from the `cwd` field of the records.
 *
 * Nothing here executes Claude Code or writes to its data: this is a
 * read-only mirror of transcripts already on disk.
 */

/** Bounded reads keep the machine-wide list pass cheap on large histories. */
export const CODE_SESSION_LIMITS = {
  /** Bytes read from the head of a transcript for the list pass. */
  headBytes: 64 * 1024,
  /** Transcript folders scanned per list pass. */
  maxFolders: 500,
  /** Transcript files scanned per list pass. */
  maxFiles: 2_000,
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Parse the newline-delimited records of a head read; drops a cut last line. */
function headRecords(head: string): Record<string, unknown>[] {
  const lines = head.split("\n");
  lines.pop();
  const records: Record<string, unknown>[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isRecord(value)) records.push(value);
    } catch {
      // A record can be longer than the head window; the detail pass re-reads.
    }
  }
  return records;
}

function cwdOf(head: string): string | undefined {
  for (const record of headRecords(head)) {
    const cwd = str(record.cwd);
    if (cwd) return cwd;
  }
  return undefined;
}

/** The recorded title, when the head carries a summary or custom title row. */
function titleOf(head: string): string | undefined {
  for (const record of headRecords(head)) {
    const custom = str(record.customTitle);
    if (custom) return custom;
    if (record.type === "summary") {
      const summary = str(record.summary);
      if (summary) return summary;
    }
  }
  return undefined;
}

/** Read at most `bytes` from the start of a file without loading the rest. */
async function headOf(path: string, bytes: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    await handle.close();
  }
}

function isSessionFile(name: string): boolean {
  return name.endsWith(".jsonl");
}

export type ClaudeCodeListOptions = {
  /** Claude Code's data folder; defaults to `claudeConfigDir()`. */
  configDir?: string;
  /** Transcripts above this size are not offered, matching the import limits. */
  maxTranscriptBytes?: number;
};

/** Every Claude Code session saved on this machine, newest first. */
export async function listClaudeCodeSessionsEverywhere(
  options: ClaudeCodeListOptions = {},
): Promise<CodeSessionSummary[]> {
  const configDir = options.configDir ?? claudeConfigDir();
  const maxTranscriptBytes = options.maxTranscriptBytes ?? CLAUDE_IMPORT_LIMITS.transcriptBytes;
  const projectsRoot = join(configDir, "projects");

  let folders: string[];
  try {
    const entries = await readdir(projectsRoot, { withFileTypes: true });
    folders = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).slice(0, CODE_SESSION_LIMITS.maxFolders);
  } catch {
    // No Claude Code data on this machine is an empty list, not an error.
    return [];
  }

  const summaries: CodeSessionSummary[] = [];
  let scanned = 0;
  for (const folder of folders) {
    if (scanned >= CODE_SESSION_LIMITS.maxFiles) break;
    let names: string[];
    try {
      names = (await readdir(join(projectsRoot, folder))).filter(isSessionFile);
    } catch {
      continue;
    }
    for (const name of names) {
      if (scanned >= CODE_SESSION_LIMITS.maxFiles) break;
      scanned += 1;
      const path = join(projectsRoot, folder, name);
      try {
        const info = await stat(path);
        if (!info.isFile() || info.size === 0 || info.size > maxTranscriptBytes) continue;
        const head = await headOf(path, CODE_SESSION_LIMITS.headBytes);
        summaries.push({
          client: "claude-code",
          sessionId: `${folder}/${name.slice(0, -".jsonl".length)}`,
          projectPath: cwdOf(head) ?? folder,
          title: titleOf(head) ?? "Claude Code session",
          startedAt: info.birthtimeMs,
          updatedAt: info.mtimeMs,
          messageCount: -1,
          sizeBytes: info.size,
        });
      } catch {
        // A transcript that vanished mid-scan or is unreadable is not offered.
      }
    }
  }
  return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
}

export type ClaudeCodeReadOptions = {
  configDir?: string;
};

/** The composite list id ("<folder>/<session>") split into its path parts. */
function parseSessionId(id: string): { folder: string; file: string } {
  const separator = id.indexOf("/");
  if (separator <= 0 || separator === id.length - 1) {
    throw new CodeSessionsError("code_session_not_found", "This Claude Code session id is not valid.");
  }
  const folder = id.slice(0, separator);
  const file = id.slice(separator + 1);
  for (const part of [folder, file]) {
    if (part.includes("\\") || part.includes("/") || part === "." || part === "..") {
      throw new CodeSessionsError("code_session_not_found", "This Claude Code session id is not valid.");
    }
  }
  return { folder, file };
}

/** One session's full transcript, parsed with the same reader the import uses. */
export async function readClaudeCodeSessionEverywhere(
  id: string,
  options: ClaudeCodeReadOptions = {},
): Promise<CodeSessionDetail> {
  const configDir = options.configDir ?? claudeConfigDir();
  const { folder, file } = parseSessionId(id);

  const projectsRoot = resolvePath(join(configDir, "projects")) + sep;
  const path = resolvePath(join(projectsRoot, folder, `${file}.jsonl`));
  if (!path.startsWith(projectsRoot)) {
    throw new CodeSessionsError("code_session_not_found", "This Claude Code session id is not valid.");
  }

  let text: string;
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error("not a file");
    if (info.size > CLAUDE_IMPORT_LIMITS.transcriptBytes) {
      throw new CodeSessionsError("code_session_unreadable", "This Claude Code session is too large to read here.");
    }
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof CodeSessionsError) throw error;
    throw new CodeSessionsError("code_session_not_found", "This Claude Code session is gone or cannot be read.");
  }

  let conversation;
  try {
    conversation = readClaudeCodeTranscript(text);
  } catch {
    throw new CodeSessionsError("code_session_unreadable", "This Claude Code session has no readable messages.");
  }

  const head = text.length > CODE_SESSION_LIMITS.headBytes ? text.slice(0, CODE_SESSION_LIMITS.headBytes) : text;
  const info = await stat(path);
  return {
    summary: {
      client: "claude-code",
      sessionId: id,
      projectPath: cwdOf(head) ?? folder,
      title: conversation.title,
      startedAt: conversation.created || info.birthtimeMs,
      updatedAt: conversation.updated || info.mtimeMs,
      messageCount: conversation.messages.length,
      sizeBytes: info.size,
    },
    messages: conversation.messages,
    notes: conversation.notes,
    sourceHash: conversation.sourceHash,
  };
}
