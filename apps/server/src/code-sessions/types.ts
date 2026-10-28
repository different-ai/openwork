import type { ImportedMessage } from "../claude-import.js";

/**
 * Coding-agent clients whose local sessions OpenWork can show in the Code tab.
 * Each entry maps to one adapter; an adapter knows where the client stores its
 * transcripts on this machine and how to read them without executing anything.
 */
export type CodeSessionClient = "claude-code" | "codex" | "pi" | "opencode";

export type CodeSessionSummary = {
  client: CodeSessionClient;
  /**
   * Stable id inside the client's namespace. It is opaque to callers and may
   * be a composite ("<scope>/<session>") when the client's on-disk layout
   * needs both parts to locate a transcript.
   */
  sessionId: string;
  /** Absolute path of the project directory the session was started in. */
  projectPath: string;
  /** Human title when the client recorded one; otherwise a derived label. */
  title: string;
  startedAt: number;
  updatedAt: number;
  /**
   * Message count when the list pass parsed the transcript, otherwise -1.
   * The list pass only reads bounded heads, so -1 is the normal case.
   */
  messageCount: number;
  sizeBytes: number;
};

export type CodeSessionDetail = {
  summary: CodeSessionSummary;
  /** Neutral transcript shape shared with Claude history import. */
  messages: ImportedMessage[];
  /** Content the source recorded that does not carry over, as plain notes. */
  notes: string[];
  /** Hash of the source bytes, to tell an unchanged re-read from a grown one. */
  sourceHash: string;
};

export type CodeSessionsClientState = {
  id: CodeSessionClient;
  /** The user can turn a client off; a disabled client is never scanned. */
  enabled: boolean;
  /** Whether the client's transcripts were found on this machine. */
  available: boolean;
};

export type CodeSessionsErrorCode =
  | "code_session_unreadable"
  | "code_session_not_found"
  | "code_session_client_unknown"
  | "code_session_client_disabled";

export class CodeSessionsError extends Error {
  constructor(
    readonly code: CodeSessionsErrorCode,
    message: string,
  ) {
    super(message);
  }
}
