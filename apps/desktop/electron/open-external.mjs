import { spawn } from "@openwork/child-process";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_TIMEOUT_MS = 4000;
export const EXTERNAL_OPEN_CAPTURE_FILENAME = "openwork-eval-external-opens.jsonl";

export function shouldCaptureExternalOpens(isPackaged, env) {
  return isPackaged === false
    && env.OPENWORK_DEV_MODE === "1"
    && env.OPENWORK_EVAL_CAPTURE_EXTERNAL_OPENS === "1";
}

function describeError(error) {
  if (error instanceof Error && error.message.trim()) return error.message;
  return String(error ?? "unknown error");
}

async function defaultOpenExternal(url, electron, capture, appendCapture) {
  if (capture) {
    await appendCapture(join(electron.app.getPath("userData"), EXTERNAL_OPEN_CAPTURE_FILENAME), `${JSON.stringify(url)}\n`, { encoding: "utf8", mode: 0o600 });
    return;
  }
  if (typeof electron.shell?.openExternal !== "function") {
    throw new Error("Electron shell.openExternal is unavailable");
  }
  await electron.shell.openExternal(url);
}

// URLs whose shell.openExternal has not settled yet. On slow machines (virtual
// desktops, endpoint security) the browser can take a minute to appear; a second
// open would only add another tab once it does.
const pendingOpens = new Set();
const PENDING_OPEN_FORGET_MS = 120_000;

export function resetPendingExternalOpensForTest() {
  pendingOpens.clear();
}

export async function openExternalUrl(url, deps = {}) {
  const env = deps.env ?? process.env;
  if (env.OPENWORK_SIMULATE_OPEN_EXTERNAL_FAILURE === "1") {
    const message = "simulated failure";
    // why: enables evals to prove the failure UX without breaking a real machine.
    console.error("[shell] openExternal failed:", message);
    return { ok: false, error: message };
  }
  if (pendingOpens.has(url)) {
    // why: the earlier request is still opening this exact URL; report it as pending instead of opening again.
    return { ok: false, pending: true, error: "still opening" };
  }

  const timeoutMs = Number.isFinite(deps.timeoutMs) ? deps.timeoutMs : DEFAULT_TIMEOUT_MS;
  const timedOut = Symbol("timed out");
  let timeoutId = null;
  let capture = false;

  try {
    const electron = deps.openExternal ? null : await (deps.loadElectron ?? (() => import("electron")))();
    capture = electron !== null && shouldCaptureExternalOpens(electron.app?.isPackaged, env);
    const openExternal = deps.openExternal ?? ((value) => defaultOpenExternal(value, electron, capture, deps.appendCapture ?? appendFile));
    const opening = Promise.resolve().then(() => openExternal(url));
    pendingOpens.add(url);
    const forget = setTimeout(() => pendingOpens.delete(url), PENDING_OPEN_FORGET_MS);
    if (typeof forget?.unref === "function") forget.unref();
    opening.then(() => undefined, () => undefined).finally(() => {
      clearTimeout(forget);
      pendingOpens.delete(url);
    });
    // why: shell.openExternal can hang forever on Windows machines with broken https URL associations; silence is the bug we're fixing.
    const outcome = await Promise.race([
      opening,
      new Promise((resolve) => {
        timeoutId = setTimeout(() => resolve(timedOut), timeoutMs);
      }),
    ]);
    if (outcome === timedOut) {
      // A slow browser is not a failed one: the original request may still open the page,
      // so starting the rundll32 fallback now would open a second tab later.
      console.error(`[shell] openExternal still pending after ${timeoutMs}ms`);
      return { ok: false, pending: true, error: `still opening after ${timeoutMs}ms` };
    }
    return { ok: true };
  } catch (error) {
    const message = describeError(error);
    console.error("[shell] openExternal failed:", message);

    const platform = deps.platform ?? process.platform;
    if (platform === "win32" && !capture) {
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
