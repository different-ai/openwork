import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir, platform } from "node:os";
type UiBridge = { baseUrl: string; token: string };
let cachedBridge: UiBridge | null = null;
let cachedBridgeAt = 0;
let cachedBridgeDiscovery: string | undefined;
const BRIDGE_CACHE_MS = 2_000;
const BRIDGE_TIMEOUT_MS = 5_000;
function userAppDataDir(): string {
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support");
  if (platform() === "win32") return process.env.APPDATA || join(homedir(), "AppData", "Roaming");
  return process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
}

function uiControlDiscoveryPaths(): string[] {
  const explicit = process.env.OPENWORK_UI_CONTROL_DISCOVERY?.trim();
  if (explicit) return [explicit];
  return [
    join(userAppDataDir(), "com.differentai.openwork", "openwork-ui-control.json"),
    join(userAppDataDir(), "com.differentai.openwork.dev", "openwork-ui-control.json"),
  ].filter((p): p is string => Boolean(p));
}

async function discoverUiBridge(): Promise<UiBridge | null> {
  // A changed discovery override points at a different desktop; never reuse
  // the bridge cached for the previous one.
  const discovery = process.env.OPENWORK_UI_CONTROL_DISCOVERY?.trim();
  if (cachedBridge && cachedBridgeDiscovery === discovery && Date.now() - cachedBridgeAt < BRIDGE_CACHE_MS) return cachedBridge;
  cachedBridge = null;
  for (const candidate of uiControlDiscoveryPaths()) {
    try {
      const raw = await readFile(candidate, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed.baseUrl === "string" && typeof parsed.token === "string") {
        const url = new URL(parsed.baseUrl);
        if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password) continue;
        cachedBridge = { baseUrl: parsed.baseUrl, token: parsed.token };
        cachedBridgeAt = Date.now();
        cachedBridgeDiscovery = discovery;
        return cachedBridge;
      }
    } catch {
      // Try next
    }
  }
  return null;
}

export async function uiBridgeRequest(
  path: string,
  options: { method?: string; body?: unknown; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<unknown> {
  const bridge = await discoverUiBridge();
  if (!bridge) return { ok: false, code: "browser_unavailable", dispatched: false, error: "The built-in browser is unavailable. Open the desktop app on the same machine as this task's server." };
  try {
    const response = await fetch(`${bridge.baseUrl}${path}`, {
      method: options.method || "GET",
      redirect: "error",
      signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? BRIDGE_TIMEOUT_MS)]) : AbortSignal.timeout(options.timeoutMs ?? BRIDGE_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${bridge.token}`,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
    const text = await response.text();
    try { return JSON.parse(text); } catch { return { ok: false, code: "browser_disconnected", mayHaveChangedState: true, retrySafe: false, error: "The browser returned no readable receipt. Inspect the page before retrying an action." }; }
  } catch {
    cachedBridge = null;
    cachedBridgeAt = 0;
    cachedBridgeDiscovery = undefined;
    return { ok: false, code: "browser_disconnected", mayHaveChangedState: true, retrySafe: false, error: "The browser connection was interrupted. An action may already have run. Reconnect, list this conversation's tabs and observe before deciding what remains." };
  }
}
