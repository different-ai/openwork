import { z } from "zod";

import { sessionInfoSchema, sessionMessageSchema, sessionTodoSchema } from "./session-read-model.js";
import type {
  SessionMessageReadModel,
  SessionSnapshotReadModel,
  SessionTodoReadModel,
} from "./session-read-model.js";
import type { ImportedSessionMessage } from "./opencode-db.js";
import type { WorkspaceExportSensitiveMode, WorkspaceExportWarning } from "./workspace-export-safety.js";

/**
 * Session export/import.
 *
 * A session lives in the OpenCode database, so it cannot be shared, archived, or
 * moved between machines today. This module turns one session (or every session
 * in a workspace) into a portable bundle and back again.
 *
 * Two shapes, one envelope:
 *  - JSON  — the canonical bundle. Import consumes exactly this.
 *  - Markdown — a read-only transcript for sharing. Never re-imported.
 *
 * A per-workspace export is the same envelope with more entries in `sessions`,
 * so there is a single schema and a single import path.
 */

export const SESSION_EXPORT_FORMAT = "openwork.session-export";
export const SESSION_EXPORT_VERSION = 1;

/** Import is additive and always creates new sessions, but a bundle is still untrusted input. */
export const MAX_IMPORT_SESSIONS = 200;
export const MAX_IMPORT_MESSAGES_PER_SESSION = 5_000;

const REDACTED = "[redacted]";

export type SessionTransferSensitiveMode = WorkspaceExportSensitiveMode;
export type SessionExportWarning = WorkspaceExportWarning;

const sessionExportEntrySchema = z.object({
  session: sessionInfoSchema,
  messages: z.array(sessionMessageSchema),
  todos: z.array(sessionTodoSchema).default([]),
});

export const sessionExportBundleSchema = z.object({
  format: z.literal(SESSION_EXPORT_FORMAT),
  version: z.number().int().positive(),
  exportedAt: z.string(),
  workspaceId: z.string(),
  /** Human-readable source, so an imported session can show where it came from. */
  workspaceName: z.string().optional(),
  sessions: z.array(sessionExportEntrySchema),
});

export type SessionExportEntry = z.infer<typeof sessionExportEntrySchema>;
export type SessionExportBundle = z.infer<typeof sessionExportBundleSchema>;

export type SessionImportSession = {
  title: string;
  sourceSessionId: string;
  messages: ImportedSessionMessage[];
};

/**
 * Part kinds that are meaningful to replay.
 *
 * Everything else OpenCode records (step boundaries, snapshots, patches, retry
 * and compaction bookkeeping) describes a live run rather than the conversation,
 * and re-inserting it into a different session would describe work that never
 * happened there.
 */
const REPLAYABLE_PART_TYPES = new Set(["text", "reasoning", "tool", "file"]);

/**
 * High-confidence secret *values*. These are redacted in place so the
 * surrounding transcript stays readable.
 */
const SECRET_VALUE_PATTERNS: ReadonlyArray<{ id: string; pattern: RegExp; replace: (match: string) => string }> = [
  {
    id: "privateKey",
    pattern: /-----BEGIN (?:[A-Z ]*)PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]*)PRIVATE KEY-----/g,
    replace: () => REDACTED,
  },
  {
    id: "JWT",
    pattern: /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9._-]{4,}\.[A-Za-z0-9._-]{4,}\b/g,
    replace: () => REDACTED,
  },
  {
    id: "Bearer",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/g,
    replace: () => `Bearer ${REDACTED}`,
  },
  {
    id: "token",
    pattern: /\b(?:ghp|gho|ghs|ghu|github_pat|xox[baprs]|sk|rk|AKIA|ASIA|AIza)[-_A-Za-z0-9]{8,}\b/g,
    replace: () => REDACTED,
  },
];

/**
 * `name: "value"` / `name=value` assignments. Only the value is replaced, and
 * only when it is long enough to plausibly be a credential.
 */
const SECRET_ASSIGNMENT_PATTERN =
  /\b(api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|client[_-]?secret|secret|password|passwd|private[_-]?key)\b(\s*[:=]\s*)(["'`]?)([^\s"'`,;]{12,})\3/gi;

function assignmentSignalId(name: string): string {
  const normalized = name.toLowerCase().replace(/[_-]/g, "");
  if (normalized.includes("apikey")) return "apiKey";
  if (normalized.includes("privatekey")) return "privateKey";
  if (normalized.includes("token")) return "token";
  if (normalized.includes("secret")) return "secret";
  if (normalized.startsWith("pass")) return "password";
  return "secret";
}

/**
 * Replace secret-looking values in free text.
 *
 * Deliberately value-level: a transcript that merely *mentions* the word
 * "password" keeps its content, while an actual token is replaced. Dropping the
 * whole message (the approach workspace config export takes) would destroy the
 * thing being shared.
 */
export function redactSecretsInText(input: string): { text: string; signals: string[] } {
  const signals = new Set<string>();
  let text = input;

  for (const { id, pattern, replace } of SECRET_VALUE_PATTERNS) {
    text = text.replace(pattern, (match) => {
      signals.add(id);
      return replace(match);
    });
  }

  text = text.replace(SECRET_ASSIGNMENT_PATTERN, (_match, name: string, separator: string, quote: string) => {
    signals.add(assignmentSignalId(name));
    return `${name}${separator}${quote}${REDACTED}${quote}`;
  });

  return { text, signals: Array.from(signals) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" ? value : undefined;
}

/** Walk every string in a part, redacting in place and collecting signals. */
function redactUnknown(value: unknown, signals: Set<string>): unknown {
  if (typeof value === "string") {
    const result = redactSecretsInText(value);
    for (const signal of result.signals) signals.add(signal);
    return result.text;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactUnknown(item, signals));
  }
  if (isRecord(value)) {
    const next: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      next[key] = redactUnknown(child, signals);
    }
    return next;
  }
  return value;
}

function redactMessage(message: SessionMessageReadModel, signals: Set<string>): SessionMessageReadModel {
  const parts = message.parts.map((part) => {
    const redacted = redactUnknown(part, signals);
    return isRecord(redacted) ? { ...part, ...redacted } : part;
  });
  return { ...message, parts };
}

function describeSignals(signals: string[]): string {
  const unique = Array.from(new Set(signals));
  if (!unique.length) return "Contains secret-like transcript content.";
  return `Contains secret-like transcript content: ${unique.slice(0, 4).join(", ")}${unique.length > 4 ? ", ..." : ""}.`;
}

function sessionLabel(session: SessionExportEntry["session"]): string {
  const title = session.title?.trim();
  return title && title.length ? title : session.id;
}

export function buildSessionExportBundle(input: {
  workspaceId: string;
  workspaceName?: string;
  snapshots: SessionSnapshotReadModel[];
  sensitiveMode: SessionTransferSensitiveMode;
  exportedAt?: Date;
}): { bundle: SessionExportBundle; warnings: SessionExportWarning[] } {
  const warnings: SessionExportWarning[] = [];
  const sessions: SessionExportEntry[] = input.snapshots.map((snapshot) => {
    const signals = new Set<string>();
    const messages = snapshot.messages.map((message) => redactMessage(message, signals));
    if (signals.size) {
      warnings.push({
        id: `session:${snapshot.session.id}`,
        label: sessionLabel(snapshot.session),
        detail: describeSignals(Array.from(signals)),
      });
    }
    return {
      session: snapshot.session,
      messages: input.sensitiveMode === "include" ? snapshot.messages : messages,
      todos: snapshot.todos,
    };
  });

  return {
    bundle: {
      format: SESSION_EXPORT_FORMAT,
      version: SESSION_EXPORT_VERSION,
      exportedAt: (input.exportedAt ?? new Date()).toISOString(),
      workspaceId: input.workspaceId,
      ...(input.workspaceName?.trim() ? { workspaceName: input.workspaceName.trim() } : {}),
      sessions,
    },
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Message text
// ---------------------------------------------------------------------------

function partText(part: Record<string, unknown>): string | null {
  const type = readString(part, "type");
  if (type === "text" || type === "reasoning") {
    const text = readString(part, "text")?.trim();
    return text && text.length ? text : null;
  }
  if (type === "tool") {
    const tool = readString(part, "tool")?.trim();
    return tool && tool.length ? `[tool: ${tool}]` : "[tool]";
  }
  return null;
}

/** Flatten a message's parts into readable plain text. */
export function extractMessageText(message: SessionMessageReadModel): string {
  const chunks: string[] = [];
  for (const part of message.parts) {
    const text = partText(part);
    if (text) chunks.push(text);
  }
  return chunks.join("\n\n").trim();
}

function normalizeRole(role: string): "user" | "assistant" {
  return role === "user" ? "user" : "assistant";
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

function formatTimestamp(value: number | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return new Date(value).toISOString();
}

function renderTodos(todos: SessionTodoReadModel[]): string[] {
  if (!todos.length) return [];
  const lines = ["#### Todos", ""];
  for (const todo of todos) {
    lines.push(`- [${todo.status === "completed" ? "x" : " "}] ${todo.content} _(${todo.priority})_`);
  }
  lines.push("");
  return lines;
}

function renderSessionSection(entry: SessionExportEntry, headingLevel: number): string[] {
  const heading = "#".repeat(headingLevel);
  const lines: string[] = [`${heading} ${sessionLabel(entry.session)}`, ""];

  const created = formatTimestamp(entry.session.time?.created);
  lines.push(`- **Session ID:** \`${entry.session.id}\``);
  if (created) lines.push(`- **Created:** ${created}`);
  lines.push(`- **Messages:** ${entry.messages.length}`);
  lines.push("");

  lines.push(...renderTodos(entry.todos));

  for (const message of entry.messages) {
    const text = extractMessageText(message);
    if (!text) continue;
    const role = normalizeRole(message.info.role);
    const timestamp = formatTimestamp(message.info.time?.created);
    lines.push(`${heading}# ${role === "user" ? "User" : "Assistant"}${timestamp ? ` · ${timestamp}` : ""}`);
    lines.push("");
    lines.push(text);
    lines.push("");
  }

  return lines;
}

export function renderSessionBundleMarkdown(bundle: SessionExportBundle): string {
  const multiple = bundle.sessions.length !== 1;
  const source = bundle.workspaceName?.trim() || bundle.workspaceId;
  const lines: string[] = [];

  if (multiple) {
    lines.push(`# Session export (${bundle.sessions.length} sessions)`, "");
    lines.push(`- **Workspace:** ${source}`);
    lines.push(`- **Exported:** ${bundle.exportedAt}`);
    lines.push("", "---", "");
    for (const entry of bundle.sessions) {
      lines.push(...renderSessionSection(entry, 2));
      lines.push("---", "");
    }
  } else {
    const entry = bundle.sessions[0];
    if (!entry) {
      lines.push("# Session export", "", "_No sessions._", "");
    } else {
      lines.push(...renderSessionSection(entry, 1));
      lines.push(`_Exported ${bundle.exportedAt} from workspace ${source}._`, "");
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export class SessionBundleError extends Error {
  readonly issues: z.ZodIssue[] | undefined;

  constructor(message: string, issues?: z.ZodIssue[]) {
    super(message);
    this.name = "SessionBundleError";
    this.issues = issues;
  }
}

export function parseSessionExportBundle(value: unknown): SessionExportBundle {
  const result = sessionExportBundleSchema.safeParse(value);
  if (!result.success) {
    throw new SessionBundleError("Not a valid OpenWork session export bundle", result.error.issues);
  }
  if (result.data.version > SESSION_EXPORT_VERSION) {
    throw new SessionBundleError(
      `Bundle version ${result.data.version} is newer than this app supports (${SESSION_EXPORT_VERSION})`,
    );
  }
  if (!result.data.sessions.length) {
    throw new SessionBundleError("Bundle contains no sessions");
  }
  if (result.data.sessions.length > MAX_IMPORT_SESSIONS) {
    throw new SessionBundleError(`Bundle contains more than ${MAX_IMPORT_SESSIONS} sessions`);
  }
  return result.data;
}

/**
 * Project a bundle onto what the OpenCode message writer accepts.
 *
 * Message and part payloads are carried across as they were exported, minus the
 * identifiers, so an imported session renders exactly like the original:
 * reasoning stays a separate reasoning part rather than being folded into the
 * reply, and tool calls stay tool calls. Parts that describe a live run rather
 * than the conversation are dropped.
 */
export function planSessionImport(bundle: SessionExportBundle): SessionImportSession[] {
  const planned: SessionImportSession[] = [];

  for (const entry of bundle.sessions) {
    const messages: ImportedSessionMessage[] = [];
    for (const message of entry.messages) {
      if (messages.length >= MAX_IMPORT_MESSAGES_PER_SESSION) break;

      const parts: Array<Record<string, unknown>> = [];
      for (const part of message.parts) {
        const type = readString(part, "type");
        if (!type || !REPLAYABLE_PART_TYPES.has(type)) continue;
        const { id: _id, messageID: _messageID, sessionID: _sessionID, ...payload } = part;
        parts.push(payload);
      }
      if (!parts.length) continue;

      const { id: _infoId, sessionID: _infoSessionId, ...data } = message.info;
      messages.push({
        role: normalizeRole(message.info.role),
        data,
        parts,
        sourceId: message.info.id,
        ...(message.info.parentID ? { sourceParentId: message.info.parentID } : {}),
      });
    }
    if (!messages.length) continue;
    planned.push({
      title: sessionLabel(entry.session).slice(0, 120),
      sourceSessionId: entry.session.id,
      messages,
    });
  }

  if (!planned.length) {
    throw new SessionBundleError("Bundle contains no messages to import");
  }

  return planned;
}
