import { attachSurface } from "@openwork/cdp";
import { resolveHost } from "./resolve.ts";
import { defaultDaytonaExec } from "./daytona.ts";
import { execInSandbox } from "./provision.ts";
import type { AttachedSurface, SurfaceHandle } from "@openwork/cdp";
import type { Host } from "./types.ts";

const DEFAULT_TIMEOUT_MS = 60_000;

function messageText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface BrowserOptions {
  name?: string;
  /**
   * Where this browser runs. Defaults to the ambient host (`resolveHost()`).
   * Pass one from `localHost()` / `daytonaSandbox(id)` to place it somewhere
   * other than the app under test.
   */
  host?: Host;
  startUrl?: string;
  headless?: boolean;
  timeoutMs?: number;
}

/**
 * A real browser, placed explicitly — the counterpart to `desktop()`.
 *
 * Owning disposal here matters: `attachSurface` only closes the CDP socket, so
 * hand-rolled `spawnChrome` + `attachSurface` left the browser PROCESS running
 * after every spec. Disposing this handle stops the client and then asks the
 * host to dispose the surface, which is what actually kills it.
 */
export async function chrome(opts: BrowserOptions = {}): Promise<AttachedSurface> {
  const host = opts.host ?? await resolveHost();
  const name = opts.name ?? "browser";
  const handle: SurfaceHandle = await host.spawnChrome(name, {
    profile: "fresh",
    startUrl: opts.startUrl,
    headless: opts.headless,
  });

  let surface: AttachedSurface;
  try {
    surface = await attachSurface(handle, { timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS });
  } catch (error) {
    await host.disposeSurface(handle).catch(() => undefined);
    throw error;
  }

  // Mutate rather than copy: `reattachSurface`/`evaluateOnSurface` assign to
  // `surface.client`, so callers must hold the same object the CDP layer heals.
  let stopped = false;
  const closeClient = surface.stop.bind(surface);
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    try {
      await closeClient();
    } finally {
      await host.disposeSurface(handle);
    }
  };
  surface.stop = stop;
  surface[Symbol.asyncDispose] = async (): Promise<void> => {
    await stop().catch((error: unknown) => {
      console.warn(`[openwork/evals] Browser ${name} cleanup failed: ${messageText(error)}`);
    });
  };
  return surface;
}

/** Observe the actual OS browser handoff in a disposable Linux desktop sandbox.
 * The real opener still runs; this never replaces the product click handler.
 */
export async function captureExternalBrowserUrls(handle: SurfaceHandle): Promise<{
  opened(): Promise<string[]>;
} & AsyncDisposable> {
  if (handle.hostKind !== "daytona" || !handle.sandboxId) {
    throw new Error("External browser URL capture requires a Daytona Linux desktop sandbox.");
  }
  const sandbox = handle.sandboxId;
  async function python(source: string): Promise<string> {
    const result = await execInSandbox(defaultDaytonaExec, sandbox, `python3 - <<'OPENWORK_CAPTURE_PY'\n${source}\nOPENWORK_CAPTURE_PY`, {
      timeoutMs: 30_000,
      context: "desktop external-browser URL witness",
    });
    return result.stdout.trim();
  }
  const state: unknown = JSON.parse(await python(String.raw`import json, os, pathlib, shutil, tempfile
opener = shutil.which("xdg-open")
if not opener:
    raise RuntimeError("xdg-open is missing")
root = pathlib.Path(tempfile.mkdtemp(prefix="openwork-browser-witness-"))
log = root / "urls.log"
log.write_text("")
backup = str(root / "xdg-open.original")
shutil.copy2(opener, backup)
import shlex
script = "#!/bin/sh\nprintf '%s\\n' \"$1\" >> " + shlex.quote(str(log)) + "\nexec " + shlex.quote(backup) + " \"$@\"\n"
pathlib.Path(opener).write_text(script)
os.chmod(opener, 0o755)
print(json.dumps({"opener": opener, "root": str(root), "log": str(log), "backup": backup}))`));
  if (typeof state !== "object" || state === null || !("root" in state) || typeof state.root !== "string"
    || !("opener" in state) || typeof state.opener !== "string" || !("log" in state) || typeof state.log !== "string"
    || !("backup" in state) || typeof state.backup !== "string") throw new Error("Invalid browser witness state");
  const { root, opener, log, backup } = state;
  return {
    async opened() {
      const value: unknown = JSON.parse(await python(`import json, pathlib\nprint(json.dumps(pathlib.Path(${JSON.stringify(log)}).read_text().splitlines()))`));
      if (!Array.isArray(value) || !value.every((url): url is string => typeof url === "string")) throw new Error("Invalid captured URLs");
      return value;
    },
    async [Symbol.asyncDispose]() {
      await python(`import shutil\nshutil.copy2(${JSON.stringify(backup)}, ${JSON.stringify(opener)})\nshutil.rmtree(${JSON.stringify(root)})`);
    },
  };
}
