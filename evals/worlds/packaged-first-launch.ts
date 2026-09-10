import { allocateFreePort, attachSurface, evaluateOnSurface } from "@openwork/cdp";
import type { AttachedSurface } from "@openwork/cdp";
import { SkipError } from "@openwork/env";
import type { Seed } from "@openwork/env";
import { localHost } from "@openwork/hosts";
import type { ElectronSurfaceOptions } from "@openwork/hosts";

/**
 * Launch of a packaged desktop flavor on an isolated profile. The fresh world
 * has no bootstrap, no activation, no sign-in: the cloud and enterprise
 * flavors render a gate above the routes here, which is the one code path
 * dogfooding never exercises. The activated world seeds the bootstrap an
 * enterprise installation carries after activation, so an update on an
 * existing customer's machine is covered too. `desktop()` cannot be used
 * because its readiness probe only recognises signed-in surfaces, so these
 * worlds attach directly.
 */

export type PackagedFlavor = "public" | "cloud" | "enterprise";

export interface RendererException {
  text: string;
  description: string;
}

/**
 * Unhandled promise rejections a packaged launch is known to produce today,
 * matched exactly against `rejectionMessage()`. Tracked debt: every entry
 * names a boot-time caller that should not reject, and the list shrinks back
 * to empty once that caller is fixed; anything not listed fails the launch
 * specs.
 *
 * Retired entries, kept so their shape is recognisable if they return:
 * - "Error: Paper Shaders: WebGL is not supported in this browser" from the
 *   decorative `Dithering` background on WebGL-less GPUs (Xvfb CI, some VDI),
 *   until DitherBackdrop started skipping the shader without WebGL2.
 * - "Error: Error invoking remote method 'openwork:desktop': Error: OpenWork
 *   must be activated from your Den portal before this command is available."
 *   from the fire-and-forget window-chrome IPC (theme.ts, ui-state-store.ts),
 *   until it caught its own rejection.
 */
export const KNOWN_LAUNCH_REJECTIONS: readonly string[] = [];

const UNHANDLED_REJECTION_PREFIX = /^Uncaught \(in promise\)\s*/i;

/**
 * A synchronous uncaught exception is what unmounts the React tree and leaves a
 * blank window. Unhandled promise rejections surface as "Uncaught (in promise)"
 * and are classified separately by `isKnownRejection`.
 */
export function isRenderCrash(exception: RendererException): boolean {
  return !UNHANDLED_REJECTION_PREFIX.test(exception.text);
}

/**
 * The rejection message as Chromium reports it: the summary text after the
 * "Uncaught (in promise)" prefix when present, otherwise the first line of the
 * rejected value's description (an Error rejection keeps its message there).
 */
export function rejectionMessage(exception: RendererException): string {
  const summary = exception.text.replace(UNHANDLED_REJECTION_PREFIX, "").trim();
  return summary || exception.description.split("\n", 1)[0].trim();
}

export function isKnownRejection(exception: RendererException): boolean {
  return !isRenderCrash(exception) && KNOWN_LAUNCH_REJECTIONS.includes(rejectionMessage(exception));
}

/** Full text of an exception for a failure message: the summary plus the stack-bearing description. */
export function describeException(exception: RendererException): string {
  return exception.description && exception.description !== exception.text
    ? `${exception.text}\n${exception.description}`
    : exception.text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function exceptionFrom(params: unknown): RendererException | null {
  if (!isRecord(params) || !isRecord(params.exceptionDetails)) return null;
  const details = params.exceptionDetails;
  const exception = isRecord(details.exception) ? details.exception : {};
  return {
    text: readString(details.text),
    description: readString(exception.description) || readString(exception.value),
  };
}

/**
 * The eval CDP client ignores protocol events, so boot-time exceptions need a
 * second session on the same page target. Enabling the Runtime domain replays
 * exceptions recorded before the session attached.
 */
async function observeRendererExceptions(surface: AttachedSurface) {
  const debuggerUrl = surface.client.webSocketDebuggerUrl;
  if (!debuggerUrl) throw new Error("Renderer exception witness needs a page debugger URL");
  const socket = new WebSocket(debuggerUrl);
  const exceptions: RendererException[] = [];
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Renderer exception witness did not attach")), 15_000);
    socket.addEventListener("open", () => socket.send(JSON.stringify({ id: 1, method: "Runtime.enable", params: {} })));
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("Renderer exception witness connection failed"));
    });
    socket.addEventListener("message", (event) => {
      const message: unknown = JSON.parse(String(event.data));
      if (!isRecord(message)) return;
      if (message.id === 1) {
        clearTimeout(timeout);
        if (message.error) reject(new Error("Runtime.enable failed for the exception witness"));
        else resolve();
      }
      if (message.method !== "Runtime.exceptionThrown") return;
      const exception = exceptionFrom(message.params);
      if (exception) exceptions.push(exception);
    });
  });
  return {
    exceptions,
    close() {
      socket.close();
    },
  };
}

async function packagedLaunchWorld(name: string, bootstrap: ElectronSurfaceOptions["bootstrap"]) {
  if (!process.env.OPENWORK_EVAL_ELECTRON_BINARY?.trim()) {
    throw new SkipError("OPENWORK_EVAL_ELECTRON_BINARY points at a packaged desktop binary");
  }
  const host = localHost();
  const handle = await host.spawnElectron(name, {
    profile: "fresh",
    bootstrap,
    prepareSharedResources: false,
    env: { OPENWORK_DEV_MODE: "0", OPENWORK_ELECTRON_START_URL: "", ELECTRON_START_URL: "" },
  });
  let app: AttachedSurface | null = null;
  let witness: Awaited<ReturnType<typeof observeRendererExceptions>> | null = null;
  const dispose = async () => {
    witness?.close();
    try {
      await app?.stop();
    } finally {
      await host.disposeSurface(handle);
    }
  };
  try {
    app = await attachSurface(handle, { timeoutMs: 60_000 });
    witness = await observeRendererExceptions(app);
  } catch (error) {
    await dispose().catch(() => undefined);
    throw error;
  }
  const attached = app;
  const observed = witness;
  return {
    app: attached,
    /** Flavor baked into the packaged artifact, as the renderer sees it. */
    flavor: () => evaluateOnSurface(attached, (): PackagedFlavor | null => {
      const electron: unknown = Reflect.get(window, "__OPENWORK_ELECTRON__");
      if (typeof electron !== "object" || electron === null) return null;
      const meta: unknown = Reflect.get(electron, "meta");
      if (typeof meta !== "object" || meta === null) return null;
      const distribution: unknown = Reflect.get(meta, "distribution");
      if (typeof distribution !== "object" || distribution === null) return null;
      const flavor: unknown = Reflect.get(distribution, "flavor");
      return flavor === "public" || flavor === "cloud" || flavor === "enterprise" ? flavor : null;
    }),
    /** Text React actually mounted, as opposed to the body chrome. */
    rootText: () => evaluateOnSurface(attached, () => document.getElementById("root")?.innerText ?? ""),
    exceptions: () => [...observed.exceptions],
    [Symbol.asyncDispose]: dispose,
  };
}

/** A machine that has never run OpenWork: no bootstrap file at all. */
export function packagedFirstLaunchWorld(_seed: Seed) {
  return packagedLaunchWorld("packaged-first-launch", undefined);
}

/**
 * An enterprise installation that already activated against its Den, as an
 * existing customer's machine looks after an update. The Den lives on a
 * closed local port so the launch is deterministic offline: the app has to
 * get past the activation gate on the seeded bootstrap alone.
 */
export async function packagedActivatedLaunchWorld(_seed: Seed) {
  const denBaseUrl = `http://127.0.0.1:${await allocateFreePort()}`;
  const world = await packagedLaunchWorld("packaged-activated-launch", {
    baseUrl: denBaseUrl,
    apiBaseUrl: denBaseUrl,
    requireSignin: true,
    enterpriseActivation: { activatedAt: new Date().toISOString(), denBaseUrl },
  });
  return { ...world, denBaseUrl };
}
