import { attachSurface, evaluateOnSurface } from "@openwork/cdp";
import type { AttachedSurface } from "@openwork/cdp";
import { SkipError } from "@openwork/env";
import type { Seed } from "@openwork/env";
import { localHost } from "@openwork/hosts";

/**
 * First launch of a packaged desktop flavor on a machine that has never run
 * OpenWork: no bootstrap, no activation, no sign-in. The cloud and enterprise
 * flavors render a gate above the routes here, which is the one code path
 * dogfooding never exercises. `desktop()` cannot be used because its readiness
 * probe only recognises signed-in surfaces, so this world attaches directly.
 */

export type PackagedFlavor = "public" | "cloud" | "enterprise";

export interface RendererException {
  text: string;
  description: string;
}

/**
 * A synchronous uncaught exception is what unmounts the React tree and leaves a
 * blank window. Unhandled promise rejections surface as "Uncaught (in promise)"
 * and never take the UI down, so they are reported but do not gate.
 */
export function isRenderCrash(exception: RendererException): boolean {
  return !/\(in promise\)/i.test(exception.text);
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

export async function packagedFirstLaunchWorld(_seed: Seed) {
  if (!process.env.OPENWORK_EVAL_ELECTRON_BINARY?.trim()) {
    throw new SkipError("OPENWORK_EVAL_ELECTRON_BINARY points at a packaged desktop binary");
  }
  const host = localHost();
  const handle = await host.spawnElectron("packaged-first-launch", {
    profile: "fresh",
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
