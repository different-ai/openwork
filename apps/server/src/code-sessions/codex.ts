import { open, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve as resolvePath, sep } from "node:path";

import { CodeSessionsError, type CodeSessionDetail, type CodeSessionSummary } from "./types.js";
import { isRecord, str } from "./records.js";

/**
 * Codex CLI adapter for the Code tab.
 *
 * Codex stores one rollout per session under
 * `<CODEX_HOME>/sessions/<year>/<month>/<day>/rollout-<stamp>-<id>.jsonl`.
 * Each line is `{ timestamp, ordinal, type, payload }`; the conversational
 * content lives in `type: "response_item"` payloads (`message`, `reasoning`,
 * `function_call`, `function_call_output`), the project path in the first
 * `session_meta` payload, and everything else (`event_msg`, `turn_context`,
 * `world_state`) is engine bookkeeping. Format observed in real rollouts
 * (Codex CLI 0.148); parsing stays tolerant so older shapes degrade instead
 * of failing.
 *
 * Nothing here executes Codex or writes to its data: this is a read-only
 * mirror of transcripts already on disk.
 */

/** Bounded reads keep the machine-wide list pass cheap on large histories. */
export const CODEX_LIMITS = {
  /** Bytes read from the head of a rollout for the list pass. */
  headBytes: 256 * 1024,
  /** Rollout files scanned per list pass. */
  maxFiles: 2_000,
} as const;

const ROLLOUT_PREFIX = "rollout-";

function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME?.trim() || join(homedir(), ".codex");
}

function sessionsRoot(configDir: string): string {
  return join(configDir, "sessions");
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

function millis(timestamp: unknown): number {
  if (typeof timestamp !== "string") return 0;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Records whose text is engine packaging, not something the person typed. */
function isMachineText(text: string): boolean {
  return /^<(skills_instructions|user_instructions|environment_context|turn_aborted|permission|system-)/.test(text.trim());
}

function metaFromHead(head: string): { sessionId?: string; projectPath?: string } {
  for (const line of head.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (!isRecord(value) || value.type !== "session_meta" || !isRecord(value.payload)) continue;
      return {
        sessionId: str(value.payload.session_id) ?? str(value.payload.id),
        projectPath: str(value.payload.cwd),
      };
    } catch {
      // A record can be longer than the head window; the detail pass re-reads.
    }
  }
  return {};
}

/** First real user message in the head; Codex records no summary row. */
function titleFromHead(head: string): string | undefined {
  for (const line of head.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (!isRecord(value) || value.type !== "response_item" || !isRecord(value.payload)) continue;
      const payload = value.payload;
      if (payload.type !== "message" || payload.role !== "user" || !Array.isArray(payload.content)) continue;
      for (const block of payload.content) {
        if (isRecord(block) && block.type === "input_text" && typeof block.text === "string") {
          const lineText = block.text.split("\n").find((part) => part.trim().length > 0)?.trim();
          if (!lineText || isMachineText(lineText)) continue;
          return lineText.length > 80 ? `${lineText.slice(0, 77)}…` : lineText;
        }
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

/** What driving needs from a rollout: the CLI session uuid and the project cwd. */
export async function codexDriveContext(
  id: string,
  options: CodexReadOptions = {},
): Promise<{ uuid: string; cwd: string }> {
  const configDir = options.configDir ?? codexHome();
  const { segments, file } = parseSessionId(id);
  const root = resolvePath(sessionsRoot(configDir)) + sep;
  const path = resolvePath(join(root, ...segments, `${file}.jsonl`));
  if (!path.startsWith(root)) {
    throw new CodeSessionsError("code_session_not_found", "This Codex session id is not valid.");
  }
  let head: string;
  try {
    head = await headOf(path, CODEX_LIMITS.headBytes);
  } catch {
    throw new CodeSessionsError("code_session_not_found", "This Codex session is gone or cannot be read.");
  }
  const meta = metaFromHead(head);
  const cwd = meta.projectPath;
  if (!cwd) {
    throw new CodeSessionsError("code_session_unreadable", "This Codex session has no project directory recorded.");
  }
  // The CLI resume id is the rollout's uuid — the filename suffix.
  return { uuid: file.slice(0, -".jsonl".length), cwd };
}

export type CodexListOptions = {
  /** Codex's data folder; defaults to CODEX_HOME or ~/.codex. */
  configDir?: string;
  /** Rollouts above this size are not offered. */
  maxTranscriptBytes?: number;
};

/** Every Codex session saved on this machine, newest first. */
export async function listCodexSessionsEverywhere(
  options: CodexListOptions = {},
): Promise<CodeSessionSummary[]> {
  const configDir = options.configDir ?? codexHome();
  const maxTranscriptBytes = options.maxTranscriptBytes ?? 512 * 1024 * 1024;
  const root = sessionsRoot(configDir);

  // Layout is sessions/<year>/<month>/<day>/rollout-*.jsonl; walk one level
  // per segment so a deep tree costs three readdirs, not a full recursion.
  let dayDirs: Array<{ path: string; year: string; month: string; day: string }> = [];
  try {
    const years = await readdir(root);
    for (const year of years) {
      let months: string[];
      try { months = await readdir(join(root, year)); } catch { continue; }
      for (const month of months) {
        let days: string[];
        try { days = await readdir(join(root, year, month)); } catch { continue; }
        for (const day of days) dayDirs.push({ path: join(root, year, month, day), year, month, day });
      }
    }
  } catch {
    // No Codex data on this machine is an empty list, not an error.
    return [];
  }

  const summaries: CodeSessionSummary[] = [];
  let scanned = 0;
  for (const { path: dayDir, year, month, day } of dayDirs) {
    if (scanned >= CODEX_LIMITS.maxFiles) break;
    let names: string[];
    try {
      names = (await readdir(dayDir)).filter((name) => name.startsWith(ROLLOUT_PREFIX) && name.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const name of names) {
      if (scanned >= CODEX_LIMITS.maxFiles) break;
      scanned += 1;
      const path = join(dayDir, name);
      try {
        const info = await stat(path);
        if (!info.isFile() || info.size === 0 || info.size > maxTranscriptBytes) continue;
        const head = await headOf(path, CODEX_LIMITS.headBytes);
        const meta = metaFromHead(head);
        summaries.push({
          client: "codex",
          // Composite id: "<year>/<month>/<day>/<rollout-name>".
          sessionId: `${year}/${month}/${day}/${name.slice(0, -".jsonl".length)}`,
          projectPath: meta.projectPath ?? `${year}-${month}-${day}`,
          title: titleFromHead(head) ?? "Codex session",
          startedAt: info.birthtimeMs,
          updatedAt: info.mtimeMs,
          messageCount: -1,
          sizeBytes: info.size,
        });
      } catch {
        // A rollout that vanished mid-scan or is unreadable is not offered.
      }
    }
  }
  return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
}

export type CodexReadOptions = {
  configDir?: string;
};

function textFromContent(content: unknown, textType: string): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter(isRecord)
    .filter((block) => block.type === textType && typeof block.text === "string")
    .map((block) => String(block.text))
    .join("\n");
}

function parseSessionId(id: string): { segments: string[]; file: string } {
  // The composite id is "<year>/<month>/<day>/<rollout-name>" without the
  // extension; ".jsonl" is appended when locating the file.
  const parts = id.split("/");
  if (parts.length !== 4 || parts.some((part) => !part || part === "." || part === ".." || part.includes("\\"))) {
    throw new CodeSessionsError("code_session_not_found", "This Codex session id is not valid.");
  }
  const [year, month, day, file] = parts;
  if (!/^\d{4}$/.test(year) || !/^\d{1,2}$/.test(month) || !/^\d{1,2}$/.test(day) || !file.startsWith(ROLLOUT_PREFIX)) {
    throw new CodeSessionsError("code_session_not_found", "This Codex session id is not valid.");
  }
  return { segments: [year, month, day], file };
}

/** One rollout's full transcript, transcoded into the neutral shape. */
export async function readCodexSessionEverywhere(
  id: string,
  options: CodexReadOptions = {},
): Promise<CodeSessionDetail> {
  const configDir = options.configDir ?? codexHome();
  const { segments, file } = parseSessionId(id);
  const root = resolvePath(sessionsRoot(configDir)) + sep;
  const path = resolvePath(join(root, ...segments, `${file}.jsonl`));
  if (!path.startsWith(root)) {
    throw new CodeSessionsError("code_session_not_found", "This Codex session id is not valid.");
  }

  let text: string;
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error("not a file");
    if (info.size > 512 * 1024 * 1024) {
      throw new CodeSessionsError("code_session_unreadable", "This Codex session is too large to read here.");
    }
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof CodeSessionsError) throw error;
    throw new CodeSessionsError("code_session_not_found", "This Codex session is gone or cannot be read.");
  }

  const rows: Array<{ time: number; type: string; payload: Record<string, unknown> }> = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (!isRecord(value) || typeof value.type !== "string" || !isRecord(value.payload)) continue;
      rows.push({ time: millis(value.timestamp), type: value.type, payload: value.payload });
    } catch {
      // A rollout can end mid-line if Codex was closed while writing.
    }
  }

  const meta = rows.find((row) => row.type === "session_meta" && str(row.payload.cwd));
  const projectPath = str(meta?.payload.cwd) ?? "";
  const toolOutputs = new Map<string, string>();
  for (const row of rows) {
    if (row.type !== "response_item" || row.payload.type !== "function_call_output") continue;
    const callId = str(row.payload.call_id);
    if (callId) toolOutputs.set(callId, typeof row.payload.output === "string" ? row.payload.output : "");
  }

  const messages: ImportedMessageMutable[] = [];
  for (const row of rows) {
    if (row.type !== "response_item") continue;
    const payload = row.payload;
    if (payload.type === "message") {
      const role = str(payload.role);
      if (role !== "user" && role !== "assistant") continue;
      const text = textFromContent(payload.content, role === "user" ? "input_text" : "output_text");
      if (!text || isMachineText(text)) continue;
      const sourceId = str(payload.id) ?? `${row.time}-${messages.length}`;
      if (role === "user") {
        messages.push({ role: "user", sourceId, time: row.time, text });
        continue;
      }
      // Codex writes one record per reply; consecutive parts merge so the
      // reply reads as one message, matching the Claude Code mirror.
      const previous = messages[messages.length - 1];
      if (previous?.role === "assistant") {
        previous.blocks.push({ type: "text", text });
        previous.completed = Math.max(previous.completed, row.time);
        continue;
      }
      messages.push({ role: "assistant", sourceId, time: row.time, completed: row.time, blocks: [{ type: "text", text }] });
      continue;
    }
    if (payload.type === "reasoning") {
      const reasoning = textFromContent(payload.content, "reasoning_text");
      if (!reasoning) continue;
      const sourceId = str(payload.id) ?? `${row.time}-r${messages.length}`;
      const previous = messages[messages.length - 1];
      if (previous?.role === "assistant") {
        previous.blocks.push({ type: "reasoning", text: reasoning });
        continue;
      }
      messages.push({ role: "assistant", sourceId, time: row.time, completed: row.time, blocks: [{ type: "reasoning", text: reasoning }] });
      continue;
    }
    if (payload.type === "function_call") {
      const callId = str(payload.call_id) ?? str(payload.id) ?? "";
      let input: Record<string, unknown> = {};
      if (typeof payload.arguments === "string") {
        try {
          const parsed: unknown = JSON.parse(payload.arguments);
          if (isRecord(parsed)) input = parsed;
        } catch {
          input = { arguments: payload.arguments };
        }
      }
      const call = {
        id: callId,
        name: str(payload.name) ?? "tool",
        input,
        output: toolOutputs.get(callId) ?? "",
        failed: false,
        time: row.time,
      };
      const sourceId = str(payload.id) ?? `${row.time}-t${messages.length}`;
      const previous = messages[messages.length - 1];
      if (previous?.role === "assistant") {
        previous.blocks.push({ type: "tool", call });
        continue;
      }
      messages.push({ role: "assistant", sourceId, time: row.time, completed: row.time, blocks: [{ type: "tool", call }] });
    }
  }

  if (messages.length === 0) {
    throw new CodeSessionsError("code_session_unreadable", "This Codex session has no readable messages.");
  }

  const info = await stat(path);
  const updated = Math.max(...messages.map((message) => (message.role === "assistant" ? message.completed : message.time)));
  return {
    summary: {
      client: "codex",
      sessionId: id,
      projectPath,
      title: titleFromHead(text.slice(0, CODEX_LIMITS.headBytes)) ?? "Codex session",
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

type AssistantBlocks = Array<
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool"; call: { id: string; name: string; input: Record<string, unknown>; output: string; failed: boolean; time: number } }
>;

type ImportedMessageMutable =
  | { role: "user"; sourceId: string; time: number; text: string }
  | { role: "assistant"; sourceId: string; time: number; completed: number; blocks: AssistantBlocks };

