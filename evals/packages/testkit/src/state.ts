import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { evalIn } from "@micx/behaviors";
import { electronProfilePaths } from "@micx/hosts";
import type { Surface } from "@micx/cdp";

export interface DenClientState {
  authTokenPresent: boolean;
  activeOrgId: string | null;
  activeOrgSlug: string | null;
  activeOrgName: string | null;
}

export interface ConnectState {
  ok: boolean;
  connectEnabled: boolean | null;
  raw: unknown;
}

export interface ConnectStateFile {
  status: "missing" | "available" | "invalid";
  connectEnabled: boolean | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function errorCode(error: unknown): string | null {
  return isRecord(error) && typeof error.code === "string" ? error.code : null;
}

export async function readDenClientState(app: Surface): Promise<DenClientState> {
  const value = await evalIn(app, `(() => ({
    authTokenPresent: Boolean((localStorage.getItem("micx.den.authToken") ?? "").trim()),
    activeOrgId: (localStorage.getItem("micx.den.activeOrgId") ?? "").trim() || null,
    activeOrgSlug: (localStorage.getItem("micx.den.activeOrgSlug") ?? "").trim() || null,
    activeOrgName: (localStorage.getItem("micx.den.activeOrgName") ?? "").trim() || null,
  }))()`);
  if (!isRecord(value)) throw new Error("The desktop returned an invalid Den client state.");
  return {
    authTokenPresent: value.authTokenPresent === true,
    activeOrgId: nullableString(value.activeOrgId),
    activeOrgSlug: nullableString(value.activeOrgSlug),
    activeOrgName: nullableString(value.activeOrgName),
  };
}

export async function readConnectState(app: Surface): Promise<ConnectState> {
  const value = await evalIn(app, `(async () => {
    // Resolve the local server the same way the app does: live runtime info
    // from the Electron bridge first (loopback port + token are ephemeral per
    // boot), then the web-mode localStorage overrides as a fallback.
    let baseUrl = "";
    let token = "";
    try {
      const invokeDesktop = window.__MICX_ELECTRON__ && window.__MICX_ELECTRON__.invokeDesktop;
      if (invokeDesktop) {
        const info = await invokeDesktop("micxServerInfo");
        if (info && info.running === true) {
          baseUrl = String(info.baseUrl ?? info.connectUrl ?? "").trim().replace(/\\/+$/, "");
          token = String(info.ownerToken ?? info.clientToken ?? "").trim();
        }
      }
    } catch {}
    if (!baseUrl || !token) {
      const port = (localStorage.getItem("micx.server.port") ?? "").trim();
      baseUrl = port ? "http://127.0.0.1:" + port : baseUrl;
      token = token || (localStorage.getItem("micx.server.token") ?? "").trim();
    }
    if (!baseUrl || !token) {
      return { ok: false, connectEnabled: null, raw: { error: "Local server credentials are unavailable." } };
    }
    try {
      const response = await fetch(
        baseUrl + "/experimental/connect/state",
        { headers: { Authorization: "Bearer " + token } },
      );
      const text = await response.text();
      let raw = text;
      try { raw = text ? JSON.parse(text) : null; } catch {}
      return {
        ok: response.ok,
        connectEnabled: raw && typeof raw === "object" && typeof raw.connectEnabled === "boolean"
          ? raw.connectEnabled
          : null,
        raw,
      };
    } catch (error) {
      return {
        ok: false,
        connectEnabled: null,
        raw: { error: error instanceof Error ? error.message : String(error) },
      };
    }
  })()`, { awaitPromise: true, timeoutMs: 15_000 });
  if (!isRecord(value)) throw new Error("The desktop returned an invalid Connect state.");
  return {
    ok: value.ok === true,
    connectEnabled: typeof value.connectEnabled === "boolean" ? value.connectEnabled : null,
    raw: value.raw,
  };
}

/** Reads the caller-visible profile filesystem; remote-hosted apps are unsupported. */
export async function readConnectStateFile(app: Surface): Promise<ConnectStateFile> {
  if (app.handle.hostKind !== "local") {
    throw new Error(`readConnectStateFile only supports local app profiles; received ${app.handle.hostKind}.`);
  }
  if (!app.handle.profileDir) throw new Error("The local app did not expose its profile directory.");
  // The local server persists runtime state next to its config file
  // (`micxConfigDir()`). The dev-mode desktop redirects that XDG config
  // root under its Electron userData dir (`<userData>/micx-dev-data/xdg/config`),
  // so probe the known layouts in order.
  const paths = electronProfilePaths(app.handle.profileDir);
  const candidates = [
    join(paths.userDataDir, "micx-dev-data", "xdg", "config", "micx", "connect-state.json"),
    join(paths.configHome, "micx", "connect-state.json"),
    join(paths.homeDir, ".config", "micx", "connect-state.json"),
  ];
  let text: string | null = null;
  for (const path of candidates) {
    try {
      text = await readFile(path, "utf8");
      break;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
  if (text === null) return { status: "missing", connectEnabled: null };
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value) || typeof value.connectEnabled !== "boolean") {
      return { status: "invalid", connectEnabled: null };
    }
    return { status: "available", connectEnabled: value.connectEnabled };
  } catch {
    return { status: "invalid", connectEnabled: null };
  }
}
