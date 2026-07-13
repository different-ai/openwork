import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 4000;

function describeError(error) {
  if (error instanceof Error && error.message.trim()) return error.message;
  return String(error ?? "unknown error");
}

async function defaultOpenExternal(url) {
  const electron = await import("electron");
  if (typeof electron.shell?.openExternal !== "function") {
    throw new Error("Electron shell.openExternal is unavailable");
  }
  await electron.shell.openExternal(url);
}

export async function openExternalUrl(url, deps = {}) {
  const env = deps.env ?? process.env;
  if (env.OPENWORK_SIMULATE_OPEN_EXTERNAL_FAILURE === "1") {
    const message = "simulated failure";
    // why: enables evals to prove the failure UX without breaking a real machine.
    console.error("[shell] openExternal failed:", message);
    return { ok: false, error: message };
  }

  const timeoutMs = Number.isFinite(deps.timeoutMs) ? deps.timeoutMs : DEFAULT_TIMEOUT_MS;
  const openExternal = deps.openExternal ?? defaultOpenExternal;
  let timeoutId = null;

  try {
    // why: shell.openExternal can hang forever on Windows machines with broken https URL associations; silence is the bug we're fixing.
    await Promise.race([
      Promise.resolve().then(() => openExternal(url)),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
    return { ok: true };
  } catch (error) {
    const message = describeError(error);
    console.error("[shell] openExternal failed:", message);

    const platform = deps.platform ?? process.platform;
    if (platform === "win32") {
      const spawnProcess = deps.spawnProcess ?? spawn;
      try {
        console.error("[shell] attempting rundll32 browser fallback");
        const child = spawnProcess("rundll32", ["url.dll,FileProtocolHandler", url], {
          detached: true,
          stdio: "ignore",
        });
        if (typeof child?.unref === "function") child.unref();
      } catch (spawnError) {
        console.error("[shell] rundll32 browser fallback failed:", describeError(spawnError));
      }
    }

    return { ok: false, error: message };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
