import { readFile, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { startDesktop } from "./desktop.mjs";
import { inspectDesktop } from "./desktop-state.mjs";

const ELECTRON_LOG = "/opt/openwork-preview/desktop/electron.log";

/**
 * What the desktop logged about startup: every error or server line, then the last distinct lines.
 * Repeated "falling back to defaults" bootstrap notices are dropped; tokens and long secrets are masked.
 */
export async function desktopLogTail(lines = 60, read = readFile) {
  let text;
  try { text = await read(ELECTRON_LOG, "utf8"); }
  catch (error) { return `(no desktop log: ${error?.code ?? error})`; }
  const mask = (line) => line.replace(/(Bearer\s+)\S+/gi, "$1[redacted]").replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[redacted]");
  const all = text.split("\n").filter((line) => line.trim() && !/desktop-bootstrap\]|desktop-bootstrap\.json|^\s*[{}]\s*$/.test(line));
  const notable = all.filter((line) => /error|fail|exit|crash|refused|EADDR|ENOENT|cannot|not found|server|engine|opencode|sidecar/i.test(line)).slice(-40);
  const tail = all.filter((line, i) => line !== all[i - 1]).slice(-lines);
  return [`-- notable (${notable.length}) --`, ...notable, `-- last ${tail.length} distinct lines --`, ...tail].map(mask).join("\n");
}

/** Tables in the profile's engine database, to show which engine initialized it first. */
export async function engineDatabaseSummary(read = readFile) {
  try {
    const profile = JSON.parse(await read("/opt/openwork-preview/desktop/profile.json", "utf8"));
    const env = profile.environment ?? {};
    const file = env.OPENCODE_DB || `${env.XDG_DATA_HOME}/opencode/opencode.db`;
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name);
      return `engine database ${file}: ${tables.length} tables: ${tables.join(", ") || "(none)"}`;
    } finally { db.close(); }
  } catch (error) {
    return `engine database unreadable: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function bootDesktopOnly(stack, { start = startDesktop, inspect = inspectDesktop, write = writeFile } = {}) {
  const root = "/opt/openwork-preview";
  try {
    const desktop = await start(stack);
    await desktop.ready;
    await inspect();
    await write(`${root}/services.json`, JSON.stringify({ desktop: desktop.url }), { mode: 0o600 });
    await write(`${root}/outputs.json`, JSON.stringify({ desktopStatus: { value: "ready-signed-out", group: "Desktop", note: "Fresh signed-out Electron app · no world services or seeded account" } }), { mode: 0o600 });
    await write(`${root}/ready-world`, JSON.stringify({ warmedAt: new Date().toISOString(), pid: process.pid, world: "desktop" }));
  } catch (error) {
    try { await write(`${root}/failed-world`, "failed"); } finally { await stack.disposeAsync(); }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const stack = new AsyncDisposableStack();
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, async () => { await stack.disposeAsync(); process.exit(0); });
  try {
    await bootDesktopOnly(stack);
    while (true) await delay(60_000);
  } catch (error) {
    console.error("Desktop-only preview startup failed:", error instanceof Error ? error.message : String(error));
    console.error(await engineDatabaseSummary());
    console.error(`Last lines of ${ELECTRON_LOG}:\n${await desktopLogTail(30)}`);
    process.exit(1);
  }
}
