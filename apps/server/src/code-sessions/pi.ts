import { open, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve as resolvePath, sep } from "node:path";

import { CodeSessionsError, type CodeSessionDetail, type CodeSessionSummary } from "./types.js";
import { isRecord, str } from "./records.js";

/**
 * Pi agent adapter for the Code tab.
 *
 * Pi stores sessions under `~/.pi/agent/sessions/<encoded-project>/<id>.jsonl`
 * as newline-delimited records. The shape this adapter accepts is the
 * documented pi-mono session format: `{ type: "message", message: { role,
 * content } }` records whose content blocks are `text` or `toolCall`, plus
 * `toolResult` records answering a toolCall by id. Parsing is tolerant: any
 * record that does not match is skipped, so a drift in the format degrades to
 * a shorter transcript instead of an error.
 *
 * NOTE: no real Pi session existed on the development machine, so this
 * adapter is validated by fixture tests only, not against a live agent's
 * on-disk data. Codex and Claude Code adapters carry the live-file evidence.
 *
 * Nothing here executes Pi or writes to its data.
 */

const PI_LIMITS = {
  /** Bytes read from the head of a session for the list pass. */
  headBytes: 64 * 1024,
  /** Session files scanned per list pass. */
  maxFiles: 2_000,
  maxFolders: 500,
} as const;

function piSessionsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.PI_HOME?.trim() || join(homedir(), ".pi"), "agent", "sessions");
}

function millis(timestamp: unknown): number {
  if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
    // Pi records epoch seconds in places; normalize to milliseconds.
    return timestamp > 1e12 ? timestamp : timestamp * 1000;
  }
  if (typeof timestamp === "string") {
    const parsed = Date.parse(timestamp);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
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

/** First real user text in the head; Pi records no summary row. */
function titleFromHead(head: string): string | undefined {
  for (const line of head.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (!isRecord(value) || value.type !== "message" || !isRecord(value.message)) continue;
      const message = value.message;
      if (message.role !== "user") continue;
      const text = textOfContent(message.content);
      const lineText = text.split("\n").find((part) => part.trim().length > 0)?.trim();
      if (!lineText) continue;
      return lineText.length > 80 ? `${lineText.slice(0, 77)}…` : lineText;
    } catch {
      continue;
    }
  }
  return undefined;
}

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(isRecord)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => String(block.text))
    .join("\n");
}

export type PiListOptions = {
  /** Pi's sessions root; defaults to PI_HOME/agent/sessions. */
  sessionsDir?: string;
  /** Sessions above this size are not offered. */
  maxTranscriptBytes?: number;
};

/** Every Pi session saved on this machine, newest first. */
export async function listPiSessionsEverywhere(
  options: PiListOptions = {},
): Promise<CodeSessionSummary[]> {
  const root = options.sessionsDir ?? piSessionsRoot();
  const maxTranscriptBytes = options.maxTranscriptBytes ?? 256 * 1024 * 1024;

  let folders: string[];
  try {
    const entries = await readdir(root, { withFileTypes: true });
    folders = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).slice(0, PI_LIMITS.maxFolders);
  } catch {
    // No Pi data on this machine is an empty list, not an error.
    return [];
  }

  const summaries: CodeSessionSummary[] = [];
  let scanned = 0;
  for (const folder of folders) {
    if (scanned >= PI_LIMITS.maxFiles) break;
    let names: string[];
    try {
      names = (await readdir(join(root, folder))).filter((name) => name.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const name of names) {
      if (scanned >= PI_LIMITS.maxFiles) break;
      scanned += 1;
      const path = join(root, folder, name);
      try {
        const info = await stat(path);
        if (!info.isFile() || info.size === 0 || info.size > maxTranscriptBytes) continue;
        const head = await headOf(path, PI_LIMITS.headBytes);
        summaries.push({
          client: "pi",
          sessionId: `${folder}/${name.slice(0, -".jsonl".length)}`,
          projectPath: folder,
          title: titleFromHead(head) ?? "Pi session",
          startedAt: info.birthtimeMs,
          updatedAt: info.mtimeMs,
          messageCount: -1,
          sizeBytes: info.size,
        });
      } catch {
        // A session that vanished mid-scan or is unreadable is not offered.
      }
    }
  }
  return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
}

export type PiReadOptions = {
  /** Pi's sessions root; defaults to PI_HOME/agent/sessions. */
  sessionsDir?: string;
};

function parseSessionId(id: string): { folder: string; file: string } {
  const separator = id.indexOf("/");
  if (separator <= 0 || separator === id.length - 1) {
    throw new CodeSessionsError("code_session_not_found", "This Pi session id is not valid.");
  }
  const folder = id.slice(0, separator);
  const file = id.slice(separator + 1);
  for (const part of [folder, file]) {
    if (part.includes("\\") || part.includes("/") || part === "." || part === "..") {
      throw new CodeSessionsError("code_session_not_found", "This Pi session id is not valid.");
    }
  }
  return { folder, file };
}

/** One session's full transcript, transcoded into the neutral shape. */
export async function readPiSessionEverywhere(
  id: string,
  options: PiReadOptions = {},
): Promise<CodeSessionDetail> {
  const root = options.sessionsDir ?? piSessionsRoot();
  const { folder, file } = parseSessionId(id);
  const sessionsRoot = resolvePath(root) + sep;
  const path = resolvePath(join(sessionsRoot, folder, `${file}.jsonl`));
  if (!path.startsWith(sessionsRoot)) {
    throw new CodeSessionsError("code_session_not_found", "This Pi session id is not valid.");
  }

  let text: string;
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error("not a file");
    if (info.size > 256 * 1024 * 1024) {
      throw new CodeSessionsError("code_session_unreadable", "This Pi session is too large to read here.");
    }
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof CodeSessionsError) throw error;
    throw new CodeSessionsError("code_session_not_found", "This Pi session is gone or cannot be read.");
  }

  type Block = { type: "text"; text: string } | { type: "reasoning"; text: string } | { type: "tool"; call: { id: string; name: string; input: Record<string, unknown>; output: string; failed: boolean; time: number } };
  type Mutable =
    | { role: "user"; sourceId: string; time: number; text: string }
    | { role: "assistant"; sourceId: string; time: number; completed: number; blocks: Block[] };

  const messages: Mutable[] = [];
  const toolOutputs = new Map<string, { output: string; failed: boolean; time: number }>();

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { continue; }
    if (!isRecord(value)) continue;
    if (value.type !== "message" || !isRecord(value.message)) continue;
    const message = value.message;
    const role = str(message.role);
    const time = millis(value.timestamp ?? message.timestamp);
    if (role === "toolResult") {
      const callId = str(message.toolCallId) ?? str(message.call_id) ?? "";
      const output = textOfContent(message.content);
      toolOutputs.set(callId, { output, failed: message.isError === true, time });
      continue;
    }
    if (role !== "user" && role !== "assistant") continue;
    if (role === "user") {
      const text = textOfContent(message.content);
      if (!text) continue;
      messages.push({ role: "user", sourceId: str(message.id) ?? `u${messages.length}`, time, text });
      continue;
    }
    const blocks: Block[] = [];
    if (Array.isArray(message.content)) {
      for (const block of message.content.filter(isRecord)) {
        if (block.type === "text" && typeof block.text === "string" && block.text) {
          blocks.push({ type: "text", text: block.text });
        } else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking) {
          blocks.push({ type: "reasoning", text: block.thinking });
        } else if (block.type === "toolCall") {
          const callId = str(block.id) ?? `t${messages.length}-${blocks.length}`;
          let input: Record<string, unknown> = {};
          if (isRecord(block.arguments)) input = block.arguments;
          else if (typeof block.arguments === "string") {
            try {
              const parsed: unknown = JSON.parse(block.arguments);
              if (isRecord(parsed)) input = parsed;
            } catch {
              input = { arguments: block.arguments };
            }
          }
          blocks.push({ type: "tool", call: { id: callId, name: str(block.name) ?? "tool", input, output: "", failed: false, time } });
        }
      }
    }
    if (blocks.length === 0) continue;
    const sourceId = str(message.id) ?? `a${messages.length}`;
    messages.push({ role: "assistant", sourceId, time, completed: time, blocks });
  }

  // Second pass: fill tool outputs the results arrived after.
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.blocks) {
      if (block.type !== "tool") continue;
      const result = toolOutputs.get(block.call.id);
      if (result) {
        block.call.output = result.output;
        block.call.failed = result.failed;
      }
    }
  }

  if (messages.length === 0) {
    throw new CodeSessionsError("code_session_unreadable", "This Pi session has no readable messages.");
  }

  const info = await stat(path);
  const updated = Math.max(...messages.map((message) => (message.role === "assistant" ? message.completed : message.time)));
  return {
    summary: {
      client: "pi",
      sessionId: id,
      projectPath: folder,
      title: titleFromHead(text.slice(0, PI_LIMITS.headBytes)) ?? "Pi session",
      startedAt: messages[0]?.time ?? info.birthtimeMs,
      updatedAt: updated || info.mtimeMs,
      messageCount: messages.length,
      sizeBytes: info.size,
    },
    messages,
    notes: [],
    sourceHash: "",
  };
}
