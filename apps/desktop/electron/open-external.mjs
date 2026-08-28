import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 4000;
const EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const OPENWORK_PROTOCOLS = new Set(["openwork:", "openwork-dev:"]);

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

function parseUrl(url) {
  if (typeof url !== "string" || !url.trim()) return null;
  try {
    return new URL(url.trim());
  } catch {
    return null;
  }
}

export function isSupportedExternalUrl(url) {
  const parsed = parseUrl(url);
  return Boolean(parsed && EXTERNAL_PROTOCOLS.has(parsed.protocol));
}

export function isLoopbackHttpUrl(url) {
  const parsed = parseUrl(url);
  return Boolean(parsed && parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase()));
}

export function isLoopbackWebUrl(url) {
  const parsed = parseUrl(url);
  return Boolean(
    parsed &&
    (parsed.protocol === "http:" || parsed.protocol === "https:") &&
    LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase()),
  );
}

export function routeOpenworkDeepLink(url, onDeepLink) {
  const parsed = parseUrl(url);
  if (!parsed || !OPENWORK_PROTOCOLS.has(parsed.protocol)) return false;
  if (typeof onDeepLink === "function") onDeepLink([url.trim()]);
  return true;
}

export function isCancelledNavigationError(error) {
  const code = typeof error?.code === "string" ? error.code : "";
  return code === "ERR_ABORTED";
}

export async function loadBrowserTabUrl(url, loadUrl) {
  try {
    return await loadUrl(url);
  } catch (error) {
    if (isCancelledNavigationError(error)) return undefined;
    throw error;
  }
}

export async function openExternalUrl(url, deps = {}) {
  const target = typeof url === "string" ? url.trim() : "";
  const parsed = parseUrl(target);
  if (!parsed) return { ok: false, error: "invalid url" };
  if (!EXTERNAL_PROTOCOLS.has(parsed.protocol)) {
    return { ok: false, error: `External URL protocol "${parsed.protocol}" is not allowed.` };
  }

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
      Promise.resolve().then(() => openExternal(target)),
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
        const child = spawnProcess("rundll32", ["url.dll,FileProtocolHandler", target], {
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
