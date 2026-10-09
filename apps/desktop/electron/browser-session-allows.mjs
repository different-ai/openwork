// Sessions whose "use the browser" question was answered with Allow. The
// answer survives desktop restarts and is dropped when the session is deleted.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const MAX_SESSIONS = 5_000;

/** @param {{ filePath?: string }} options */
export function createBrowserSessionAllows({ filePath } = {}) {
  /** @type {Set<string>} */
  let sessions = new Set();
  if (filePath) {
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8"));
      if (Array.isArray(parsed)) sessions = new Set(parsed.filter((entry) => typeof entry === "string" && entry.trim()));
    } catch {
      // A missing or unreadable file means no session has been allowed yet.
    }
  }
  function save() {
    if (!filePath) return;
    try {
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, `${JSON.stringify([...sessions])}\n`, "utf8");
    } catch (error) {
      // The allow still holds for this run; it is asked again after a restart.
      console.warn("[openwork] could not save browser session allows", error);
    }
  }
  return {
    /** @param {string} sessionId */
    has: (sessionId) => sessions.has(sessionId),
    /** @param {string} sessionId */
    add(sessionId) {
      if (sessions.has(sessionId)) return;
      sessions.add(sessionId);
      // Insertion order is oldest first; keep the file bounded.
      for (const oldest of sessions) {
        if (sessions.size <= MAX_SESSIONS) break;
        sessions.delete(oldest);
      }
      save();
    },
    /** @param {string} sessionId */
    remove(sessionId) {
      if (sessions.delete(sessionId)) save();
    },
  };
}
