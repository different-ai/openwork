import { writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { startDesktop } from "./desktop.mjs";
import { inspectDesktop } from "./desktop-state.mjs";

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
  } catch {
    console.error("Desktop-only preview startup failed");
    process.exit(1);
  }
}
