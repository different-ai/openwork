import { readFile } from "node:fs/promises";
import { attachSurface, dumpScreenState, evaluateOnSurface } from "@openwork/cdp";
import type { AttachedSurface, SurfaceHandle } from "@openwork/cdp";
import { resolveHost } from "./resolve.ts";
import type { Host } from "./types.ts";

const DEFAULT_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 250;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function messageText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function appendCoworkerLog(error: unknown, handle: SurfaceHandle): Promise<unknown> {
  const logPath = handle.meta?.log;
  if (!logPath) return error;
  try {
    const log = await readFile(logPath, "utf8");
    if (!log.trim()) return error;
    const tail = log.trimEnd().split(/\r?\n/).slice(-40).join("\n");
    return new Error(`${messageText(error)}\n\nLast 40 lines of ${logPath}:\n${tail}`, { cause: error });
  } catch {
    return error;
  }
}

async function waitForCoworkerReadiness(app: AttachedSurface, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const ready = await evaluateOnSurface(app, `(() => {
        const text = (document.body?.innerText ?? "").toLowerCase();
        return Boolean(window.__COWORKER__)
          && ["welcome to open coworker", "add a coworker", "your team"]
            .some((label) => text.includes(label));
      })()`, { timeoutMs: Math.min(8_000, Math.max(1, deadline - Date.now())) });
      if (ready === true) return;
    } catch {
      // Navigation and cold embedded-server startup can briefly block CDP.
    }
    await sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
  }
  throw new Error(`Open Coworker did not become interactive after ${timeoutMs}ms. On screen: ${await dumpScreenState(app)}.`);
}

export interface CoworkerOptions {
  name?: string;
  host?: Host;
  profileDir?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface CoworkerHandle extends AttachedSurface {
  workspaceRoot: string;
  stop(): Promise<void>;
}

/** Launch and attach to the standalone Open Coworker product surface. */
export async function coworker(options: CoworkerOptions = {}): Promise<CoworkerHandle> {
  const host = options.host ?? await resolveHost();
  const packagedBinary = process.env.OPENWORK_EVAL_ELECTRON_BINARY?.trim();
  const handle = await host.spawnElectron(options.name ?? "coworker", {
    profile: "fresh",
    profileDir: options.profileDir,
    env: options.env,
    devCommand: packagedBinary ? undefined : "dev:coworker",
    prepareSharedResources: false,
  });
  let attached: AttachedSurface | null = null;
  try {
    attached = await attachSurface(handle, { timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS });
    await waitForCoworkerReadiness(attached, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    let stopped = false;
    const stop = async (): Promise<void> => {
      if (stopped) return;
      stopped = true;
      try {
        await attached?.stop();
      } finally {
        await host.disposeSurface(handle);
      }
    };
    return {
      handle: attached.handle,
      client: attached.client,
      workspaceRoot: host.workspaceRoot,
      stop,
      [Symbol.asyncDispose]: () => stop().catch((error: unknown) => {
        console.warn(`[openwork/evals] Coworker cleanup failed: ${messageText(error)}`);
      }),
    };
  } catch (error) {
    const readinessError = attached ? await appendCoworkerLog(error, handle) : error;
    try {
      await attached?.stop();
    } finally {
      await host.disposeSurface(handle).catch(() => undefined);
    }
    throw readinessError;
  }
}
