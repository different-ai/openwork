import { attachSurface, evaluate } from "@openwork/cdp";
import { resolveHost } from "./resolve.ts";
import type { AttachedSurface, Surface, SurfaceHandle } from "@openwork/cdp";
import type { Host } from "./types.ts";

const DEFAULT_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 250;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function messageText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logCleanupError(name: string, error: unknown): void {
  console.warn(`[openwork/evals] Desktop ${name} cleanup failed: ${messageText(error)}`);
}

export interface DesktopOptions {
  name?: string;
  mode?: "spawn" | "attach";
  bootstrap?: {
    baseUrl: string;
    apiBaseUrl?: string;
    requireSignin?: boolean;
  };
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface AppReadiness {
  state: "welcome" | "workspace";
  workspaceId: string | null;
  route: string;
}

export interface DesktopHandle extends AttachedSurface {
  readiness: AppReadiness;
  stop(): Promise<void>;
}

interface ReadinessProbe {
  ready: boolean;
  state: AppReadiness["state"] | null;
  workspaceId: string | null;
  route: string;
  text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseProbe(value: unknown): ReadinessProbe {
  if (!isRecord(value)) {
    return { ready: false, state: null, workspaceId: null, route: "", text: "" };
  }
  const state = value.state === "welcome" || value.state === "workspace" ? value.state : null;
  return {
    ready: value.ready === true,
    state,
    workspaceId: typeof value.workspaceId === "string" ? value.workspaceId : null,
    route: typeof value.route === "string" ? value.route : "",
    text: typeof value.text === "string" ? value.text : "",
  };
}

async function probeReadiness(app: Surface): Promise<ReadinessProbe> {
  const value = await evaluate(app.client, `(() => {
    const text = document.body?.innerText ?? "";
    const route = window.location.hash.replace(/^#/, "") || window.location.pathname;
    const workspace = /^\\/workspace\\/([^/?#]+)\\/session\\/?$/.exec(route);
    const transitional = [
      "Preparing workspace",
      "Connecting signed-in services",
      "Connecting services",
      "Loading available resources",
    ].some((message) => text.includes(message));
    const taskUiMounted = text.includes("What do you need done?")
      || [...document.querySelectorAll("button")]
        .some((button) => (button.textContent ?? "").trim() === "Run task");
    const state = route === "/welcome"
      ? "welcome"
      : workspace && taskUiMounted
        ? "workspace"
        : null;
    return {
      ready: Boolean(window.__openworkControl && !transitional && state),
      state,
      workspaceId: state === "workspace" ? workspace?.[1] ?? null : null,
      route,
      text: text.slice(0, 300),
    };
  })()`);
  return parseProbe(value);
}

async function waitForReadiness(app: Surface, timeoutMs: number): Promise<AppReadiness> {
  const deadline = Date.now() + timeoutMs;
  let last = await probeReadiness(app).catch(() => parseProbe(null));
  while (Date.now() < deadline) {
    try {
      last = await probeReadiness(app);
      if (last.ready && last.state) {
        return { state: last.state, workspaceId: last.workspaceId, route: last.route };
      }
    } catch {
      // Navigations can briefly destroy the execution context while the app boots.
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(
    `OpenWork desktop did not become ready after ${timeoutMs}ms. Current route: ${last.route || "<unknown>"}. Visible text: ${JSON.stringify(last.text)}`,
  );
}

async function closeSpawnedSurface(
  attached: AttachedSurface | null,
  host: Host | null,
  handle: SurfaceHandle,
): Promise<void> {
  try {
    await attached?.stop();
  } finally {
    await host?.disposeSurface(handle);
  }
}

export async function desktop(opts: DesktopOptions = {}): Promise<DesktopHandle> {
  const mode = opts.mode ?? "spawn";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let host: Host | null = null;
  let handle: SurfaceHandle;

  if (mode === "attach") {
    const cdpUrl = process.env.OPENWORK_EVAL_CDP_URL?.trim();
    if (!cdpUrl) {
      throw new Error('desktop({ mode: "attach" }) requires OPENWORK_EVAL_CDP_URL to point at a running Electron app.');
    }
    handle = {
      name: opts.name ?? "attached-app",
      kind: "electron",
      hostKind: "attached",
      cdpUrl,
    };
  } else {
    host = await resolveHost();
    handle = await host.spawnElectron(opts.name ?? "spec", {
      profile: "fresh",
      bootstrap: opts.bootstrap,
      env: opts.env,
    });
  }

  let attached: AttachedSurface | null = null;
  try {
    attached = await attachSurface(handle, { timeoutMs });
    const readiness = await waitForReadiness(attached, timeoutMs);
    let stopped = false;
    const stop = async (): Promise<void> => {
      if (stopped) return;
      stopped = true;
      await closeSpawnedSurface(attached, host, handle);
    };
    const dispose = async (): Promise<void> => {
      await stop().catch((error: unknown) => logCleanupError(handle.name, error));
    };
    return {
      handle: attached.handle,
      client: attached.client,
      readiness,
      stop,
      [Symbol.asyncDispose]: dispose,
    };
  } catch (error) {
    await closeSpawnedSurface(attached, host, handle)
      .catch((cleanupError: unknown) => logCleanupError(handle.name, cleanupError));
    throw error;
  }
}
