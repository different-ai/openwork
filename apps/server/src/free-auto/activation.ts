// Engine calls are relayed only while a task the user started from the app is live.
export const ACTIVATION_IDLE_MS = 15 * 60_000;
export const ACTIVATION_MAX_MS = 2 * 60 * 60_000;
const TASK_START_PATH = /\/session\/([^/]+)\/(prompt|prompt_async|message|command|summarize)$/;
const TASK_END_PATH = /\/session\/([^/]+)(?:\/abort)?$/;

export type TaskRoute = { kind: "start" | "end"; sessionID: string };
/** Which task-lifecycle request the app sent through the OpenWork server, if any. */
export function taskRoute(method: string, path: string): TaskRoute | null {
  const ended = method === "POST" || method === "DELETE" ? TASK_END_PATH.exec(path) : null;
  if (ended && (method === "DELETE" || path.endsWith("/abort"))) return { kind: "end", sessionID: decodeURIComponent(ended[1]) };
  const started = method === "POST" ? TASK_START_PATH.exec(path) : null;
  return started ? { kind: "start", sessionID: decodeURIComponent(started[1]) } : null;
}

/**
 * The window in which the engine may spend Auto: opened by a send with Auto
 * selected, extended by each completed model call, closed after 15 idle
 * minutes, after 2 hours, or when the last live session ends. No timers: it
 * closes lazily when checked.
 */
export class TaskActivation {
  private window: { openedAt: number; lastActivityAt: number; sessions: Set<string> } | null = null;
  constructor(private readonly now: () => number = Date.now) {}
  isOpen(): boolean {
    if (!this.window) return false;
    const now = this.now();
    if (now - this.window.lastActivityAt >= ACTIVATION_IDLE_MS || now - this.window.openedAt >= ACTIVATION_MAX_MS) {
      this.window = null;
      return false;
    }
    return true;
  }
  /** Open for a session: an engine call that names a session must name one of these. */
  allows(sessionID: string | null): boolean {
    return this.isOpen() && (!sessionID || this.window!.sessions.has(sessionID));
  }
  start(sessionID: string): void {
    const now = this.now();
    if (!this.isOpen()) this.window = { openedAt: now, lastActivityAt: now, sessions: new Set() };
    this.window!.sessions.add(sessionID);
    this.window!.lastActivityAt = now;
  }
  touch(): void { if (this.window) this.window.lastActivityAt = this.now(); }
  end(sessionID: string): void {
    if (!this.window) return;
    this.window.sessions.delete(sessionID);
    if (this.window.sessions.size === 0) this.window = null;
  }
  close(): void { this.window = null; }
}
