import { channel } from "node:diagnostics_channel";
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

const phases = new Set([
  "app.ready", "window.create", "window.show", "runtime.start", "server.start",
  "engine.v1.resolve", "engine.version-probe", "engine.v1.serve", "engine.v2.resolve", "engine.v2.version-probe", "engine.v2.serve",
  "plugin-deps.seed", "plugin-deps.extract", "ca.bundle", "windows.shortcut",
  "org.activation", "bootstrap.apply", "server.restart.requested", "engine.restart.requested",
]);
const restartCauses = new Set(["requested", "startup-recovery", "settings", "connection-recovery", "provider-auth", "reload-escalation"]);
const events = channel("openwork.desktop.startup-phase");

/** Static labels only: never pass errors, paths, URLs, arguments or configuration. */
export function startupPhase(name, cause = undefined) {
  const id = {};
  events.publish({ type: "start", name, id, cause });
  return (failed = false) => events.publish({ type: "end", name, id, failed });
}

export async function withStartupPhase(name, operation, cause = undefined) {
  const end = startupPhase(name, cause);
  try { const result = await operation(); end(); return result; }
  catch (error) { end(true); throw error; }
}

/** Best-effort, immediate small writes: a crash leaves the last started phase on disk.
 * Only allowlisted labels and internally generated numeric fields reach this file.
 * No process output or exception messages are accepted, so home paths and secrets
 * are redacted by exclusion rather than an incomplete credential regex.
 */
export function createStartupLog({ directory, maxBytes = 256 * 1024, now = () => performance.now(), heartbeatMs = 250, stallMs = 2000 }) {
  const filePath = path.join(directory, "desktop-startup.log");
  const open = new Map();
  const startedAt = now();
  let lastTick = startedAt;
  let sequence = 0;
  let lastCompleted = null;
  let closed = false;
  const write = (record) => {
    try {
      const line = `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...record })}\n`;
      if (Buffer.byteLength(line) > maxBytes) return;
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      let size = 0;
      try { size = statSync(filePath).size; } catch { /* first launch */ }
      if (size + Buffer.byteLength(line) > maxBytes) renameSync(filePath, `${filePath}.1`);
      appendFileSync(filePath, line, { mode: 0o600 });
    } catch { /* Diagnostics must never change startup behavior. */ }
  };
  const checkpoint = () => {
    const current = now();
    const lateMs = current - lastTick - heartbeatMs;
    if (lateMs > stallMs) {
      write({ event: "stall", lateMs: Math.round(lateMs), elapsedMs: Math.round(current - lastTick), open: [...open.values()].map(({ phase, id }) => ({ phase, id })), lastCompleted });
      lastTick = current;
    }
  };
  const receive = (message) => {
    if (closed || !message || typeof message !== "object" || !phases.has(message.name)) return;
    // Check before removing a phase: synchronous work can finish before the
    // overdue heartbeat callback gets a turn, otherwise attribution is lost.
    checkpoint();
    if (message.type === "start") {
      if (open.size >= 128 || open.has(message.id)) return;
      const entry = { phase: message.name, id: ++sequence, startedAt: now() };
      open.set(message.id, entry);
      const cause = restartCauses.has(message.cause) ? message.cause : undefined;
      write({ event: "start", phase: entry.phase, id: entry.id, ...(cause ? { cause } : {}) });
    } else if (message.type === "end") {
      const entry = open.get(message.id);
      if (!entry) return;
      open.delete(message.id);
      lastCompleted = entry.phase;
      write({ event: "end", phase: entry.phase, id: entry.id, durationMs: Math.max(0, Math.round(now() - entry.startedAt)), status: message.failed === true ? "error" : "ok" });
    }
  };
  events.subscribe(receive);
  write({ event: "launch" });
  const timer = setInterval(() => { checkpoint(); lastTick = now(); }, heartbeatMs);
  timer.unref();
  return {
    filePath,
    // Bounded files only; used by the existing diagnostics export, not a new UI.
    read: () => {
      const read = (file) => { try { return readFileSync(file, "utf8").slice(-maxBytes); } catch { return ""; } };
      return { filePath: "<userData>/logs/desktop-startup.log", previous: read(`${filePath}.1`), current: read(filePath) };
    },
    close: () => { if (closed) return; checkpoint(); closed = true; clearInterval(timer); events.unsubscribe(receive); },
  };
}
