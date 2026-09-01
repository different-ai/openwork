import { createAndSelectWorkspace, signInDesktopAs } from "@openwork/behaviors";
import { attachSurface, evaluateOnSurface, isInteractive, probeAppStateOnSurface } from "@openwork/cdp";
import type { Surface } from "@openwork/cdp";
import { desktop } from "@openwork/hosts";
import { liveSharedProductionStateEnv } from "@openwork/hosts";
import { trackResource } from "@openwork/world";
import type { AppReadiness, DesktopHandle, Host, InstalledProductionDesktopState } from "@openwork/hosts";
import type { Den } from "./den.ts";
import type { Place } from "./place.ts";

interface SharedAppOptions {
  den: Den;
  place: Place;
  host?: Host;
  model?: string;
  workspacePath?: string;
  /** Reuse this caller-owned local Electron profile root instead of creating one. */
  profileDir?: string;
  /** Eval-only delay before the desktop starts its embedded OpenWork server. */
  localServerDelayMs?: number;
  /** Observe a fresh profile after workspace setup but before Cloud sign-in. */
  beforeSignIn?: (surface: Surface) => Promise<void>;
}

export interface SignedInAppOptions extends SharedAppOptions {
  as: string;
  signIn?: true;
}

export interface FreshAppOptions extends SharedAppOptions {
  as?: never;
  signIn: false;
}

export type AppOptions = SignedInAppOptions | FreshAppOptions;

/** A desktop; its Electron profile root is available at handle.profileDir. */
export interface App extends DesktopHandle {
  workspaceId: string;
  /** Live-state launches may have no selected workspace; snapshots preserve that as null. */
  snapshotWorkspaceId?: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serializedPageValue(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Installed production renderer state could not be serialized.");
  return serialized.replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

async function mirrorInstalledProductionRendererState(target: Surface): Promise<AppReadiness> {
  const cdpUrl = process.env.OPENWORK_EVAL_INSTALLED_PRODUCTION_CDP_URL?.trim() || "http://127.0.0.1:9223";
  await using source = await attachSurface({
    name: "installed-production-source",
    kind: "electron",
    hostKind: "local",
    cdpUrl,
  });
  const raw = await evaluateOnSurface(source, `({
    route: location.hash,
    entries: Object.entries(localStorage).filter(([key]) => key.startsWith("openwork.")),
  })`);
  if (!isRecord(raw) || typeof raw.route !== "string" || !Array.isArray(raw.entries)) {
    throw new Error(`Installed production desktop at ${cdpUrl} returned invalid renderer state.`);
  }
  const entries: [string, string][] = [];
  for (const entry of raw.entries) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || typeof entry[1] !== "string") {
      throw new Error(`Installed production desktop at ${cdpUrl} returned an invalid localStorage entry.`);
    }
    entries.push([entry[0], entry[1]]);
  }
  try {
    await evaluateOnSurface(target, `(() => {
      const state = ${serializedPageValue({ route: raw.route, entries })};
      for (const [key, value] of state.entries) localStorage.setItem(key, value);
      location.hash = state.route;
      location.reload();
      return true;
    })()`);
  } catch {
    // The CDP evaluator includes expression prefixes in timeout errors. Never
    // propagate the expression because it contains production localStorage.
    throw new Error("Dev desktop could not adopt installed production renderer state.");
  }

  const deadline = Date.now() + 60_000;
  let lastRoute = "";
  while (Date.now() < deadline) {
    try {
      const probe = await probeAppStateOnSurface(target, { timeoutMs: 5_000 });
      lastRoute = probe.route;
      if (isInteractive(probe) && probe.surface && !probe.route.endsWith("/signin")) {
        return { state: probe.surface, workspaceId: probe.workspaceId, route: probe.route };
      }
    } catch {
      // Reload briefly destroys the renderer execution context.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Dev desktop did not adopt installed production renderer state within 60 seconds; last route ${JSON.stringify(lastRoute)}.`);
}

export async function liveSharedProductionApp(options: {
  host: Host;
  name: string;
  state: InstalledProductionDesktopState;
}): Promise<App> {
  const surface = await desktop({
    name: options.name,
    host: options.host,
    devCommand: "dev",
    prepareSharedResources: false,
    env: liveSharedProductionStateEnv(options.state),
  });
  try {
    const readiness = await mirrorInstalledProductionRendererState(surface);
    const selectedWorkspaceId = readiness.workspaceId;
    return {
      handle: surface.handle,
      client: surface.client,
      readiness,
      workspaceRoot: surface.workspaceRoot,
      workspaceId: selectedWorkspaceId === null ? "" : selectedWorkspaceId,
      snapshotWorkspaceId: selectedWorkspaceId,
      stop: () => surface.stop(),
      [Symbol.asyncDispose]: () => surface[Symbol.asyncDispose](),
    };
  } catch (error) {
    await surface[Symbol.asyncDispose]();
    throw error;
  }
}

export async function app(options: AppOptions): Promise<App> {
  if (options.signIn === false) {
    const env: Record<string, string> = {};
    if (options.model) env.OPENWORK_EVAL_MODEL = options.model;
    if (options.localServerDelayMs !== undefined) {
      env.OPENWORK_EVAL_LOCAL_SERVER_DELAY_MS = String(options.localServerDelayMs);
    }
    const surface = await desktop({
      name: "testkit-fresh",
      host: options.host ?? options.place.host(),
      profileDir: options.profileDir,
      bootstrap: {
        baseUrl: options.den.ref.webUrl,
        requireSignin: false,
      },
      env: Object.keys(env).length > 0 ? env : undefined,
    });
    if (surface.handle.pid !== undefined) {
      await trackResource({ kind: "process", id: String(surface.handle.pid), label: "electron", match: process.env.OPENWORK_EVAL_ELECTRON_BINARY?.trim() || "dev:electron" });
    }
    if (surface.handle.meta?.profileOwner !== "caller" && typeof surface.handle.profileDir === "string") {
      await trackResource({ kind: "tmpdir", id: surface.handle.profileDir, label: "electron-profile" });
    }
    try {
      const path = options.workspacePath ?? `/tmp/openwork-fresh-${Date.now()}`;
      const { workspaceId } = await createAndSelectWorkspace(surface, { path });
      await options.beforeSignIn?.(surface);
      return {
        handle: surface.handle,
        client: surface.client,
        readiness: surface.readiness,
        workspaceRoot: surface.workspaceRoot,
        workspaceId,
        stop: () => surface.stop(),
        [Symbol.asyncDispose]: () => surface[Symbol.asyncDispose](),
      };
    } catch (error) {
      await surface[Symbol.asyncDispose]();
      throw error;
    }
  }
  const member = options.as === "admin" ? options.den.admin : options.den.members[options.as];
  if (!member) {
    const available = ["admin", ...Object.keys(options.den.members)].join(", ");
    throw new Error(`Unknown Den member ${JSON.stringify(options.as)}. Available: ${available}`);
  }
  const env: Record<string, string> = {};
  if (options.model) env.OPENWORK_EVAL_MODEL = options.model;
  if (options.localServerDelayMs !== undefined) {
    env.OPENWORK_EVAL_LOCAL_SERVER_DELAY_MS = String(options.localServerDelayMs);
  }
  const surface = await desktop({
    name: `testkit-${options.as}`,
    host: options.host ?? options.place.host(),
    profileDir: options.profileDir,
    bootstrap: {
      baseUrl: options.den.ref.webUrl,
      requireSignin: false,
    },
    env: Object.keys(env).length > 0 ? env : undefined,
  });
  if (surface.handle.pid !== undefined) {
    await trackResource({ kind: "process", id: String(surface.handle.pid), label: "electron", match: process.env.OPENWORK_EVAL_ELECTRON_BINARY?.trim() || "dev:electron" });
  }
  if (surface.handle.meta?.profileOwner !== "caller" && typeof surface.handle.profileDir === "string") {
    await trackResource({ kind: "tmpdir", id: surface.handle.profileDir, label: "electron-profile" });
  }
  try {
    // Workspace first, then the org sign-in: the signed-in org shell offers no
    // Add workspace entry, so a member's workspace exists before they connect.
    const path = options.workspacePath ?? `/tmp/openwork-${options.as}-${Date.now()}`;
    await createAndSelectWorkspace(surface, { path });
    await options.beforeSignIn?.(surface);
    await signInDesktopAs(surface, options.den.ref, member);
    const { workspaceId } = await createAndSelectWorkspace(surface, { path });
    return {
      handle: surface.handle,
      client: surface.client,
      readiness: surface.readiness,
      workspaceRoot: surface.workspaceRoot,
      workspaceId,
      stop: () => surface.stop(),
      [Symbol.asyncDispose]: () => surface[Symbol.asyncDispose](),
    };
  } catch (error) {
    await surface[Symbol.asyncDispose]();
    throw error;
  }
}
