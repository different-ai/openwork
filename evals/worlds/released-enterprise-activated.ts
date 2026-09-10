import { cp, rm } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { createAndSelectWorkspace, quitDesktop, signInDesktopAs } from "@openwork/behaviors";
import { attachSurface, evaluateOnSurface, probeAppStateOnSurface } from "@openwork/cdp";
import type { AppStateProbe, AttachedSurface, SurfaceHandle } from "@openwork/cdp";
import { SkipError } from "@openwork/env";
import type { Den, Seed } from "@openwork/env";
import { localHost } from "@openwork/hosts";
import type { Host } from "@openwork/hosts";
import type { PackagedFlavor, RendererException } from "./packaged-first-launch.ts";

/**
 * A packaged enterprise desktop whose installation is ALREADY activated
 * against a private Den: the bootstrap carries `enterpriseActivation`, so the
 * activation gate is skipped and the forced sign-in surface renders instead.
 * The fresh-machine gate (packaged-first-launch) never reaches this code path,
 * and it is the one every existing enterprise user boots into after an update.
 *
 * `OPENWORK_EVAL_ELECTRON_BINARY` names the release under test. The optional
 * `OPENWORK_EVAL_RELEASED_BASELINE_BINARY` names an older release used to
 * create the profile that the release under test then opens (an in-place
 * update), so migrations on a real user's profile are exercised too. The
 * optional `OPENWORK_EVAL_RELEASED_VERSION` pins the version the binary under
 * test must report, so a stale download cannot pass as the release.
 */

export { isRenderCrash } from "./packaged-first-launch.ts";

/** Build facts the main process reports for the running executable. */
export interface AppBuildInfo {
  version: string;
  gitSha: string | null;
}

export interface ReleasedLaunch extends AsyncDisposable {
  app: AttachedSurface;
  binary: string;
  profileDir: string;
  /** Flavor baked into the packaged artifact, as the renderer sees it. */
  flavor(): Promise<PackagedFlavor | null>;
  /** Version of the executable that is actually running, from its main process. */
  buildInfo(): Promise<AppBuildInfo | null>;
  /** Activation stamp the renderer received through the desktop bootstrap. */
  activation(): Promise<{ activatedAt: string; denBaseUrl: string } | null>;
  /** Text React actually mounted, as opposed to the body chrome. */
  rootText(): Promise<string>;
  state(): Promise<AppStateProbe>;
  exceptions(): RendererException[];
  /** Ask Chromium to close the browser the way a quit does, then make sure the process is gone. */
  quit(): Promise<void>;
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

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidIsAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return !pidIsAlive(pid);
}

function parseBuildInfo(value: unknown): AppBuildInfo | null {
  if (!isRecord(value) || typeof value.version !== "string") return null;
  return { version: value.version, gitSha: typeof value.gitSha === "string" ? value.gitSha : null };
}

function parseActivation(value: unknown): { activatedAt: string; denBaseUrl: string } | null {
  if (!isRecord(value)) return null;
  const activatedAt = readString(value.activatedAt);
  const denBaseUrl = readString(value.denBaseUrl);
  return activatedAt && denBaseUrl ? { activatedAt, denBaseUrl } : null;
}

/**
 * The local host resolves the executable from the ambient
 * OPENWORK_EVAL_ELECTRON_BINARY at spawn time; an update scenario needs two
 * executables in one test, so the override is scoped to one spawn here.
 */
async function withElectronBinary<T>(binary: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.OPENWORK_EVAL_ELECTRON_BINARY;
  process.env.OPENWORK_EVAL_ELECTRON_BINARY = binary;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.OPENWORK_EVAL_ELECTRON_BINARY;
    else process.env.OPENWORK_EVAL_ELECTRON_BINARY = previous;
  }
}

/** The bundle electron-updater replaces in place: the nearest `.app` ancestor of the executable. */
function appBundleOf(binary: string): string | null {
  for (let dir = dirname(binary); dir !== dirname(dir); dir = dirname(dir)) {
    if (dir.endsWith(".app")) return dir;
  }
  return null;
}

/**
 * An activated installation checks for updates, and on quit electron-updater
 * installs the newest published release over its own bundle. The release under
 * test would then silently become a newer one between launches (0.18.45 booted
 * as 0.18.46 within a single run once 0.18.46 was published), so every launch
 * boots a private copy of the bundle and the downloaded release stays pristine.
 * The copy keeps the code signature and notarization ticket intact.
 */
async function pristineCopy(binary: string, root: string): Promise<string> {
  const bundle = appBundleOf(binary);
  if (!bundle) return binary;
  const copy = join(root, basename(bundle));
  await cp(bundle, copy, { recursive: true, verbatimSymlinks: true });
  return join(copy, relative(bundle, binary));
}

export interface LaunchOptions {
  binary: string;
  /** Caller-owned profile root; reuse it across launches to simulate a restart or an update. */
  profileDir: string;
  /** Write the activated bootstrap before launching. Omit on relaunches so the file the product persisted is what boots. */
  seedBootstrap: boolean;
}

/** The activated bootstrap the product itself writes after a successful enterprise sign-in. */
export function activatedBootstrap(den: Den, activatedAt: string) {
  return {
    baseUrl: den.ref.webUrl,
    apiBaseUrl: den.ref.apiUrl,
    requireSignin: true,
    enterpriseActivation: { activatedAt, denBaseUrl: den.ref.webUrl },
  };
}

async function launchReleased(host: Host, name: string, den: Den, activatedAt: string, options: LaunchOptions): Promise<ReleasedLaunch> {
  const handle: SurfaceHandle = await withElectronBinary(options.binary, () => host.spawnElectron(name, {
    profile: "fresh",
    profileDir: options.profileDir,
    prepareSharedResources: false,
    ...(options.seedBootstrap ? { bootstrap: activatedBootstrap(den, activatedAt) } : {}),
    env: { OPENWORK_DEV_MODE: "0", OPENWORK_ELECTRON_START_URL: "", ELECTRON_START_URL: "" },
  }));
  let app: AttachedSurface | null = null;
  let witness: Awaited<ReturnType<typeof observeRendererExceptions>> | null = null;
  let stopped = false;
  const dispose = async () => {
    if (stopped) return;
    stopped = true;
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
    binary: options.binary,
    profileDir: options.profileDir,
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
    buildInfo: async () => parseBuildInfo(await evaluateOnSurface(attached, async (): Promise<unknown> => {
      const electron: unknown = Reflect.get(window, "__OPENWORK_ELECTRON__");
      if (typeof electron !== "object" || electron === null) return null;
      const invoke: unknown = Reflect.get(electron, "invokeDesktop");
      if (typeof invoke !== "function") return null;
      return invoke("appBuildInfo");
    }, { awaitPromise: true, timeoutMs: 15_000 })),
    activation: async () => parseActivation(await evaluateOnSurface(attached, (): unknown => {
      const electron: unknown = Reflect.get(window, "__OPENWORK_ELECTRON__");
      if (typeof electron !== "object" || electron === null) return null;
      const meta: unknown = Reflect.get(electron, "meta");
      if (typeof meta !== "object" || meta === null) return null;
      const bootstrap: unknown = Reflect.get(meta, "desktopBootstrap");
      if (typeof bootstrap !== "object" || bootstrap === null) return null;
      return Reflect.get(bootstrap, "enterpriseActivation");
    })),
    rootText: () => evaluateOnSurface(attached, () => document.getElementById("root")?.innerText ?? ""),
    state: () => probeAppStateOnSurface(attached, { timeoutMs: 8_000 }),
    exceptions: () => [...observed.exceptions],
    async quit() {
      if (stopped) return;
      // Browser.close runs Chromium's normal shutdown, which flushes renderer
      // storage the way a user quit does; a signal would not.
      await quitDesktop(attached);
      if (handle.pid !== undefined) await waitUntilGone(handle.pid, 20_000);
      await dispose();
    },
    [Symbol.asyncDispose]: dispose,
  };
}

export async function releasedEnterpriseActivatedWorld(seed: Seed) {
  const binary = process.env.OPENWORK_EVAL_ELECTRON_BINARY?.trim();
  if (!binary) throw new SkipError("OPENWORK_EVAL_ELECTRON_BINARY points at a packaged enterprise desktop binary");
  const baselineBinary = process.env.OPENWORK_EVAL_RELEASED_BASELINE_BINARY?.trim() || null;
  const expectedVersion = process.env.OPENWORK_EVAL_RELEASED_VERSION?.trim() || null;
  const den = await seed.den();
  const host = localHost();
  const activatedAt = new Date().toISOString();
  const launches: ReleasedLaunch[] = [];
  const ownedProfiles: string[] = [];
  let launchIndex = 0;

  return {
    den,
    binary,
    baselineBinary,
    /** Version the binary under test must report, when the caller pinned one. */
    expectedVersion,
    activatedAt,
    /** A fresh caller-owned profile root that outlives every launch until the world is disposed. */
    newProfileDir(label: string): string {
      const root = seed.tmpPath(`released-${label}`);
      ownedProfiles.push(root);
      return join(root, "profile");
    },
    async launch(options: LaunchOptions): Promise<ReleasedLaunch> {
      launchIndex += 1;
      const name = `released-enterprise-${launchIndex}`;
      const bundleRoot = seed.tmpPath(`${name}-bundle`);
      ownedProfiles.push(bundleRoot);
      const binary = await pristineCopy(options.binary, bundleRoot);
      const launch = await launchReleased(host, name, den, activatedAt, { ...options, binary });
      launches.push(launch);
      return launch;
    },
    /** Sign the Den admin into this launch and select a fresh local workspace folder, as an activated user would. */
    async signInAndSelectWorkspace(launch: ReleasedLaunch): Promise<{ workspaceId: string; route: string }> {
      await signInDesktopAs(launch.app, den.ref, den.admin);
      const workspacePath = seed.tmpPath("released-workspace");
      ownedProfiles.push(workspacePath);
      return createAndSelectWorkspace(launch.app, { path: workspacePath });
    },
    [Symbol.asyncDispose]: async () => {
      for (const launch of launches.reverse()) {
        try {
          await launch[Symbol.asyncDispose]();
        } catch {
          // Every launch is best-effort disposed; the profile removal below still runs.
        }
      }
      for (const profile of ownedProfiles) await rm(profile, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}
