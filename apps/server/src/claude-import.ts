import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";

/**
 * Turns Claude history into native OpenCode v2 sessions.
 *
 * Sources:
 * - Claude data export (`conversations.json`, alone or in its ZIP part):
 *   claude.ai chats. Claude's export does not contain Cowork tasks.
 * - Claude Code transcripts (`~/.claude/projects/<folder>/<id>.jsonl`).
 *
 * Only the branch the person last saw is imported (walked back from the
 * newest message), so edited and retried turns do not interleave. Nothing in
 * the history is executed: tool calls become finished tool rows.
 */

export const CLAUDE_IMPORT_LIMITS = {
  /** Uploaded export file (ZIP or JSON). */
  uploadBytes: 256 * 1024 * 1024,
  zipEntries: 10_000,
  /** Declared uncompressed size of one ZIP entry we read. */
  entryBytes: 512 * 1024 * 1024,
  transcriptBytes: 64 * 1024 * 1024,
  conversations: 5_000,
} as const;

export class ClaudeImportError extends Error {
  constructor(readonly code: ClaudeImportErrorCode, message: string) {
    super(message);
  }
}

export type ClaudeImportErrorCode =
  | "claude_export_manifest"
  | "claude_export_unreadable"
  | "claude_export_empty"
  | "claude_export_too_large"
  | "claude_transcript_unreadable";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function millis(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Key-sorted JSON, so a hash does not depend on property order. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// ---------------------------------------------------------------------------
// ZIP (stored + deflate). Claude's export parts are ordinary ZIP files; we
// read only the entries we need and never write anything to disk.

type ZipEntry = { name: string; method: number; compressedSize: number; size: number; localOffset: number; flags: number };

export function listZipEntries(bytes: Buffer): ZipEntry[] {
  const minimum = 22;
  if (bytes.length < minimum) throw new ClaudeImportError("claude_export_unreadable", "This file is not a Claude export.");
  let end = -1;
  for (let index = bytes.length - minimum; index >= Math.max(0, bytes.length - minimum - 0xffff); index -= 1) {
    if (bytes.readUInt32LE(index) === 0x06054b50) { end = index; break; }
  }
  if (end < 0) throw new ClaudeImportError("claude_export_unreadable", "This file is not a Claude export.");
  const count = bytes.readUInt16LE(end + 10);
  const directoryOffset = bytes.readUInt32LE(end + 16);
  if (count === 0xffff || directoryOffset === 0xffffffff) {
    throw new ClaudeImportError("claude_export_too_large", "This export is too large to read here. Export a shorter date range.");
  }
  if (count > CLAUDE_IMPORT_LIMITS.zipEntries) throw new ClaudeImportError("claude_export_too_large", "This export has too many files.");
  const entries: ZipEntry[] = [];
  let offset = directoryOffset;
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50) {
      throw new ClaudeImportError("claude_export_unreadable", "This export is damaged. Download it again.");
    }
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    entries.push({
      flags: bytes.readUInt16LE(offset + 8),
      method: bytes.readUInt16LE(offset + 10),
      compressedSize: bytes.readUInt32LE(offset + 20),
      size: bytes.readUInt32LE(offset + 24),
      localOffset: bytes.readUInt32LE(offset + 42),
      name: bytes.toString("utf8", offset + 46, offset + 46 + nameLength),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

export function readZipEntry(bytes: Buffer, entry: ZipEntry): Buffer {
  if (entry.flags & 1) throw new ClaudeImportError("claude_export_unreadable", "Encrypted exports are not supported.");
  if (entry.size > CLAUDE_IMPORT_LIMITS.entryBytes || entry.compressedSize === 0xffffffff) {
    throw new ClaudeImportError("claude_export_too_large", "This export is too large to read here. Export a shorter date range.");
  }
  const header = entry.localOffset;
  if (header + 30 > bytes.length || bytes.readUInt32LE(header) !== 0x04034b50) {
    throw new ClaudeImportError("claude_export_unreadable", "This export is damaged. Download it again.");
  }
  const start = header + 30 + bytes.readUInt16LE(header + 26) + bytes.readUInt16LE(header + 28);
  const data = bytes.subarray(start, start + entry.compressedSize);
  if (data.length !== entry.compressedSize) throw new ClaudeImportError("claude_export_unreadable", "This export is damaged. Download it again.");
  if (entry.method === 0) return Buffer.from(data);
  if (entry.method !== 8) throw new ClaudeImportError("claude_export_unreadable", "This export uses an unsupported compression.");
  const inflated = inflateRawSync(data, { maxOutputLength: CLAUDE_IMPORT_LIMITS.entryBytes });
  if (inflated.length !== entry.size) throw new ClaudeImportError("claude_export_unreadable", "This export is damaged. Download it again.");
  return inflated;
}

// ---------------------------------------------------------------------------
// Neutral transcript shape shared by both sources.

export type ImportedToolCall = { id: string; name: string; input: JsonRecord; output: string; failed: boolean; time: number };

export type ImportedMessage =
  | { role: "user"; sourceId: string; time: number; text: string }
  | {
      role: "assistant";
      sourceId: string;
      time: number;
      completed: number;
      model?: string;
      blocks: Array<{ type: "text"; text: string } | { type: "reasoning"; text: string } | { type: "tool"; call: ImportedToolCall }>;
    };

export type ImportedConversation = {
  format: "claude-chat" | "claude-code";
  sourceId: string;
  title: string;
  created: number;
  updated: number;
  messages: ImportedMessage[];
  /** Hash of the source records, to tell an unchanged re-import from an edited one. */
  sourceHash: string;
  /** Content that could not be carried over, as plain notes. */
  notes: string[];
};

function toolOutputText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content.map((block) => {
      if (!isRecord(block)) return "";
      if (block.type === "text" && typeof block.text === "string") return block.text;
      if (block.type === "image") return "[image]";
      return "";
    }).filter((part) => part.length > 0);
    return parts.join("\n");
  }
  return "";
}

/** Walk from the newest message to the root through `parent`. */
function currentBranch<T>(items: T[], id: (item: T) => string | undefined, parent: (item: T) => string | undefined): T[] {
  const byId = new Map<string, T>();
  for (const item of items) {
    const key = id(item);
    if (key) byId.set(key, item);
  }
  const leaf = items[items.length - 1];
  if (!leaf) return [];
  const branch: T[] = [];
  const seen = new Set<string>();
  let cursor: T | undefined = leaf;
  while (cursor) {
    const key = id(cursor);
    if (!key || seen.has(key)) break;
    seen.add(key);
    branch.push(cursor);
    const next = parent(cursor);
    cursor = next ? byId.get(next) : undefined;
  }
  return branch.reverse();
}

// ---------------------------------------------------------------------------
// Claude data export

function parseExportJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new ClaudeImportError("claude_export_unreadable", "This file is not a Claude export.");
  }
}

function looksLikeZip(bytes: Buffer): boolean {
  return bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50;
}

function isManifest(value: unknown): boolean {
  return isRecord(value) && Array.isArray(value.data_files);
}

/** Read every conversation in a Claude export ZIP part or `conversations.json`. */
export function readClaudeExport(bytes: Buffer): ImportedConversation[] {
  if (bytes.length > CLAUDE_IMPORT_LIMITS.uploadBytes) {
    throw new ClaudeImportError("claude_export_too_large", "This export is too large. Export a shorter date range.");
  }
  let raw: unknown;
  if (looksLikeZip(bytes)) {
    const entries = listZipEntries(bytes);
    const conversations = entries.filter((entry) => entry.name.split("/").pop() === "conversations.json");
    if (conversations.length === 0) {
      throw new ClaudeImportError("claude_export_empty", "This part of the export has no conversations. Choose the file that starts with conversations.");
    }
    const all: unknown[] = [];
    for (const entry of conversations) {
      const value = parseExportJson(readZipEntry(bytes, entry));
      if (Array.isArray(value)) all.push(...value);
    }
    raw = all;
  } else {
    raw = parseExportJson(bytes);
  }
  if (isManifest(raw)) {
    throw new ClaudeImportError(
      "claude_export_manifest",
      "This is the export's list of downloads, not the conversations. Open its conversations link in your browser, then choose that file.",
    );
  }
  const records = Array.isArray(raw) ? raw : [raw];
  if (records.length > CLAUDE_IMPORT_LIMITS.conversations) {
    throw new ClaudeImportError("claude_export_too_large", "This export has too many conversations. Export a shorter date range.");
  }
  const conversations = records.filter(isRecord).map(convertChat).filter((item): item is ImportedConversation => item !== undefined);
  if (conversations.length === 0) throw new ClaudeImportError("claude_export_empty", "This export has no conversations to import.");
  return conversations;
}

const CHAT_ROOT = "00000000-0000-4000-8000-000000000000";

function convertChat(record: JsonRecord): ImportedConversation | undefined {
  const sourceId = str(record.uuid);
  const rawMessages = Array.isArray(record.chat_messages) ? record.chat_messages.filter(isRecord) : [];
  if (!sourceId || rawMessages.length === 0) return undefined;
  const branch = currentBranch(
    rawMessages,
    (item) => str(item.uuid),
    (item) => {
      const parent = str(item.parent_message_uuid);
      return parent === CHAT_ROOT ? undefined : parent;
    },
  );
  const notes = new Set<string>();
  if (branch.length < rawMessages.length) notes.add("Only the latest version of edited or retried messages was imported.");
  const messages: ImportedMessage[] = [];
  for (const item of branch) {
    const id = str(item.uuid) ?? "";
    const time = millis(item.created_at) ?? millis(record.created_at) ?? 0;
    const attachments = [item.attachments, item.files].some((value) => Array.isArray(value) && value.length > 0);
    if (attachments) notes.add("Attached files are not included in Claude's export.");
    const content = Array.isArray(item.content) ? item.content.filter(isRecord) : [];
    if (item.sender === "human") {
      const text = content.filter((block) => block.type === "text").map((block) => str(block.text) ?? "").join("\n") || str(item.text) || "";
      if (text) messages.push({ role: "user", sourceId: id, time, text });
      continue;
    }
    if (item.sender !== "assistant") continue;
    const blocks: Extract<ImportedMessage, { role: "assistant" }>["blocks"] = [];
    const results = new Map<string, JsonRecord>();
    for (const block of content) {
      const key = str(block.tool_use_id);
      if (block.type === "tool_result" && key) results.set(key, block);
    }
    for (const block of content) {
      if (block.type === "text" && str(block.text)) blocks.push({ type: "text", text: String(block.text) });
      else if (block.type === "thinking" && str(block.thinking)) blocks.push({ type: "reasoning", text: String(block.thinking) });
      else if (block.type === "tool_use") {
        const callId = str(block.id) ?? `${id}-${blocks.length}`;
        const result = results.get(callId);
        blocks.push({
          type: "tool",
          call: {
            id: callId,
            name: str(block.name) ?? "tool",
            input: isRecord(block.input) ? block.input : {},
            output: toolOutputText(result?.content),
            failed: result?.is_error === true,
            time: millis(block.start_timestamp) ?? time,
          },
        });
      }
    }
    if (blocks.length === 0 && str(item.text)) blocks.push({ type: "text", text: String(item.text) });
    if (blocks.length === 0) continue;
    messages.push({ role: "assistant", sourceId: id, time, completed: millis(item.updated_at) ?? time, blocks });
  }
  if (messages.length === 0) return undefined;
  // The account that owns a conversation is personal data; it is not imported.
  const { account: _account, ...rest } = record;
  return {
    format: "claude-chat",
    sourceId,
    title: str(record.name) ?? firstUserLine(messages) ?? "Claude chat",
    created: millis(record.created_at) ?? messages[0]?.time ?? 0,
    updated: millis(record.updated_at) ?? messages[messages.length - 1]?.time ?? 0,
    messages,
    sourceHash: sha256(stableJson(rest)),
    notes: [...notes],
  };
}

function firstUserLine(messages: ImportedMessage[]): string | undefined {
  const first = messages.find((message) => message.role === "user");
  if (!first || first.role !== "user") return undefined;
  const line = first.text.split("\n").find((part) => part.trim().length > 0)?.trim();
  if (!line) return undefined;
  return line.length > 80 ? `${line.slice(0, 77)}…` : line;
}

// ---------------------------------------------------------------------------
// Claude Code transcripts

/** The folder name Claude Code uses for a project directory. */
export function claudeCodeProjectFolder(directory: string): string {
  return directory.replace(/[^a-zA-Z0-9]/g, "-");
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter(isRecord).filter((block) => block.type === "text").map((block) => str(block.text) ?? "").join("\n");
}

/** Claude Code wraps commands and hook output in tags; they are not what the person typed. */
function isMachineText(text: string): boolean {
  const trimmed = text.trim();
  return /^<(command-name|command-message|command-args|local-command-stdout|local-command-caveat|system-reminder|bash-input|bash-stdout|bash-stderr)>/.test(trimmed);
}

export function readClaudeCodeTranscript(text: string): ImportedConversation {
  if (Buffer.byteLength(text, "utf8") > CLAUDE_IMPORT_LIMITS.transcriptBytes) {
    throw new ClaudeImportError("claude_export_too_large", "This Claude Code session is too large to import.");
  }
  const rows: JsonRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isRecord(value)) rows.push(value);
    } catch {
      // A transcript can end mid-line if Claude Code was closed while writing.
    }
  }
  const linked = rows.filter((row) => str(row.uuid) && !row.isSidechain);
  const conversational = linked.filter((row) => row.type === "user" || row.type === "assistant");
  const leaf = conversational[conversational.length - 1];
  const sourceId = str(leaf?.sessionId) ?? str(rows.find((row) => str(row.sessionId))?.sessionId);
  if (!leaf || !sourceId) throw new ClaudeImportError("claude_transcript_unreadable", "This Claude Code session has no messages.");
  // Walk the full parent chain (attachments and other records sit between
  // messages), ending at the newest message.
  const leafIndex = linked.indexOf(leaf);
  const branch = currentBranch(linked.slice(0, leafIndex + 1), (row) => str(row.uuid), (row) => str(row.parentUuid))
    .filter((row) => row.type === "user" || row.type === "assistant");
  const notes = new Set<string>();
  if (rows.some((row) => row.isSidechain === true)) notes.add("Sub-agent work is summarised by its result, not imported step by step.");

  const results = new Map<string, JsonRecord>();
  for (const row of branch) {
    if (row.type !== "user" || !isRecord(row.message) || !Array.isArray(row.message.content)) continue;
    for (const block of row.message.content) {
      const key = isRecord(block) ? str(block.tool_use_id) : undefined;
      if (isRecord(block) && block.type === "tool_result" && key) results.set(key, block);
    }
  }

  const messages: ImportedMessage[] = [];
  for (const row of branch) {
    const message = isRecord(row.message) ? row.message : undefined;
    const time = millis(row.timestamp) ?? 0;
    const id = str(row.uuid) ?? "";
    if (!message) continue;
    if (row.type === "user") {
      const userText = textOf(message.content);
      if (!userText || isMachineText(userText) || row.isMeta === true || row.isCompactSummary === true) continue;
      messages.push({ role: "user", sourceId: id, time, text: userText });
      continue;
    }
    const content = typeof message.content === "string" ? [{ type: "text", text: message.content }] : Array.isArray(message.content) ? message.content.filter(isRecord) : [];
    const blocks: Extract<ImportedMessage, { role: "assistant" }>["blocks"] = [];
    for (const block of content) {
      if (block.type === "text" && str(block.text)) blocks.push({ type: "text", text: String(block.text) });
      else if (block.type === "thinking" && str(block.thinking)) blocks.push({ type: "reasoning", text: String(block.thinking) });
      else if (block.type === "tool_use") {
        const callId = str(block.id) ?? `${id}-${blocks.length}`;
        const result = results.get(callId);
        blocks.push({
          type: "tool",
          call: {
            id: callId,
            name: str(block.name) ?? "tool",
            input: isRecord(block.input) ? block.input : {},
            output: toolOutputText(result?.content),
            failed: result?.is_error === true,
            time,
          },
        });
      }
    }
    if (blocks.length === 0) continue;
    const model = str(message.model);
    // Claude Code writes one record per content block of the same reply;
    // OpenWork shows a reply as one message, so consecutive parts merge.
    const previous = messages[messages.length - 1];
    if (previous?.role === "assistant") {
      previous.blocks.push(...blocks);
      previous.completed = Math.max(previous.completed, time);
      previous.model ??= model;
      continue;
    }
    messages.push({ role: "assistant", sourceId: id, time, completed: time, model, blocks });
  }
  if (messages.length === 0) throw new ClaudeImportError("claude_transcript_unreadable", "This Claude Code session has no messages.");
  const titles = rows.map((row) => str(row.customTitle) ?? (row.type === "summary" ? str(row.summary) : undefined)).filter((value): value is string => value !== undefined);
  return {
    format: "claude-code",
    sourceId,
    title: titles[titles.length - 1] ?? firstUserLine(messages) ?? "Claude Code session",
    created: messages[0]?.time ?? 0,
    updated: Math.max(...messages.map((message) => (message.role === "assistant" ? message.completed : message.time))),
    messages,
    sourceHash: sha256(text),
    notes: [...notes],
  };
}

// ---------------------------------------------------------------------------
// Native OpenCode v2 import payload

export const IMPORTED_AGENT = "imported";
const UNKNOWN_MODEL = { id: "unknown", providerID: "claude" };

export function nativeSessionId(conversation: Pick<ImportedConversation, "format" | "sourceId">, directory: string): string {
  return `ses_claudeimport_${sha256(JSON.stringify([conversation.format, conversation.sourceId, directory])).slice(0, 32)}`;
}

function nativeMessageId(sessionId: string, index: number, sourceId: string): string {
  return `msg_${index.toString(16).padStart(8, "0")}${sha256(JSON.stringify([sessionId, sourceId])).slice(0, 24)}`;
}

export type NativeImportPayload = {
  info: JsonRecord & {
    id: string;
    metadata: { claudeImport: { format: ImportedConversation["format"]; sourceID: string; sourceHash: string; notes: string[]; usageUnknown: true } };
  };
  messages: JsonRecord[];
  location: { directory: string };
};

export function buildNativeImport(conversation: ImportedConversation, options: { directory: string; projectID: string }): NativeImportPayload {
  const id = nativeSessionId(conversation, options.directory);
  const location = { directory: options.directory };
  const messages = conversation.messages.map((message, index): JsonRecord => {
    const base = { id: nativeMessageId(id, index, message.sourceId), metadata: { claudeImport: { sourceID: message.sourceId } } };
    if (message.role === "user") return { ...base, type: "user", time: { created: message.time }, text: message.text };
    return {
      ...base,
      type: "assistant",
      time: { created: message.time, completed: message.completed },
      agent: IMPORTED_AGENT,
      model: message.model ? { id: message.model, providerID: "anthropic" } : UNKNOWN_MODEL,
      finish: "stop",
      content: message.blocks.map((block) => {
        if (block.type !== "tool") return { type: block.type, text: block.text };
        const output = [{ type: "text", text: block.call.output || "(No result was saved.)" }];
        return {
          type: "tool",
          id: block.call.id,
          name: block.call.name,
          executed: true,
          time: { created: block.call.time, completed: block.call.time },
          state: block.call.failed
            ? { status: "error", input: block.call.input, error: { type: "imported", message: block.call.output || "Failed" }, content: output }
            : { status: "completed", input: block.call.input, content: output },
        };
      }),
    };
  });
  return {
    info: {
      id,
      projectID: options.projectID,
      title: conversation.title,
      // No agent or model: continuing an imported chat uses the workspace defaults.
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: conversation.created, updated: conversation.updated, idle: conversation.updated },
      location,
      metadata: {
        claudeImport: {
          format: conversation.format,
          sourceID: conversation.sourceId,
          sourceHash: conversation.sourceHash,
          notes: conversation.notes,
          // Imported usage and cost are unknown, not zero.
          usageUnknown: true,
        },
      },
    },
    messages,
    location,
  };
}
