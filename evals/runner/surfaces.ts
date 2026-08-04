import { connect, debuggerUrlFor, pickAppTarget } from "./cdp.ts";
import { firstPageTarget, waitForCdp } from "./targets.ts";
import type { CdpClient, CdpTarget } from "./cdp.ts";
import type { Surface } from "@openwork/cdp";
import type { EnvManifest } from "./env-manifest.ts";
import type { ChromeSurfaceOptions, ElectronSurfaceOptions, Host, SurfaceHandle, SurfaceKind } from "./hosts/types.ts";

const SURFACE_CDP_TIMEOUT_MS = 30_000;

export type { Surface } from "@openwork/cdp";

export interface SurfaceFacade {
  electron(name: string, opts?: ElectronSurfaceOptions): Promise<Surface>;
  chrome(name: string, opts?: ChromeSurfaceOptions): Promise<Surface>;
  get(name: string): Surface;
}

interface SurfaceRegistryOptions {
  hosts: Map<string, Host>;
  defaultHostKind: string;
  onLog: (msg: string) => void;
  manifest?: EnvManifest | null;
  connectSurface?: (handle: SurfaceHandle) => Promise<CdpClient>;
}

interface SurfaceEntry {
  surface: Surface;
  host: Host | null;
  spawned: boolean;
}

function messageText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function defaultConnectSurface(handle: SurfaceHandle): Promise<CdpClient> {
  const target: CdpTarget = handle.kind === "electron"
    ? await pickAppTarget(handle.cdpUrl)
    : await firstPageTarget(handle.cdpUrl);
  const client = await connect(debuggerUrlFor(handle.cdpUrl, target));
  await client.send("Page.enable").catch(() => undefined);
  return client;
}

export class SurfaceRegistry {
  private hosts: Map<string, Host>;
  private defaultHostKind: string;
  private onLog: (msg: string) => void;
  private manifest: EnvManifest | null;
  private connectSurface: (handle: SurfaceHandle) => Promise<CdpClient>;
  private entries: Map<string, SurfaceEntry>;

  constructor({ hosts, defaultHostKind, onLog, manifest = null, connectSurface = defaultConnectSurface }: SurfaceRegistryOptions) {
    this.hosts = hosts;
    this.defaultHostKind = defaultHostKind;
    this.onLog = onLog;
    this.manifest = manifest;
    this.connectSurface = connectSurface;
    this.entries = new Map();
  }

  async electron(name: string, opts?: ElectronSurfaceOptions): Promise<Surface> {
    return this.surface(name, "electron", (host) => host.spawnElectron(name, opts), opts);
  }

  async chrome(name: string, opts?: ChromeSurfaceOptions): Promise<Surface> {
    return this.surface(name, "chrome", (host) => host.spawnChrome(name, opts), opts);
  }

  get(name: string): Surface {
    const entry = this.entries.get(name);
    if (entry) return entry.surface;
    throw new Error(`No surface named ${JSON.stringify(name)}. Known surfaces: ${this.knownSurfaceNames()}.`);
  }

  async disposeAll(): Promise<void> {
    for (const entry of this.entries.values()) {
      try {
        entry.surface.client.close();
      } catch (error) {
        this.onLog(`Could not close surface ${entry.surface.handle.name} CDP client: ${messageText(error)}`);
      }
      if (entry.spawned && entry.host) {
        try {
          await entry.host.disposeSurface(entry.surface.handle);
        } catch (error) {
          this.onLog(`Could not dispose surface ${entry.surface.handle.name}: ${messageText(error)}`);
        }
      }
    }
    this.entries.clear();
  }

  private knownSurfaceNames(): string {
    const names = [...this.entries.keys()].sort();
    return names.length > 0 ? names.join(", ") : "none";
  }

  private async surface(
    name: string,
    kind: SurfaceKind,
    spawn: (host: Host) => Promise<SurfaceHandle>,
    _opts?: ElectronSurfaceOptions | ChromeSurfaceOptions,
  ): Promise<Surface> {
    const existing = this.entries.get(name);
    if (existing) return existing.surface;

    const manifestHandle = this.manifest?.surfaces[name];
    if (manifestHandle) {
      if (manifestHandle.kind !== kind) {
        throw new Error(`Manifest surface ${name} is ${manifestHandle.kind}, not ${kind}.`);
      }
      try {
        const adopted = await this.attach(manifestHandle);
        this.entries.set(name, { surface: adopted, host: null, spawned: false });
        this.onLog(`Adopted ${kind} surface ${name} from env manifest at ${manifestHandle.cdpUrl}.`);
        return adopted;
      } catch (error) {
        this.onLog(`Manifest surface ${name} at ${manifestHandle.cdpUrl} is not reachable: ${messageText(error)}`);
        const host = this.hosts.get(manifestHandle.hostKind) ?? this.hosts.get(this.defaultHostKind);
        if (!host) {
          throw new Error(`no host available for kind ${manifestHandle.hostKind}; cannot respawn ${kind} surface ${name}.`);
        }
        return this.spawnAndAttach(name, kind, host, spawn);
      }
    }

    const host = this.hosts.get(this.defaultHostKind);
    if (!host) {
      throw new Error(`no host available for kind ${this.defaultHostKind}; cannot spawn ${kind} surface ${name}.`);
    }
    return this.spawnAndAttach(name, kind, host, spawn);
  }

  private async spawnAndAttach(name: string, kind: SurfaceKind, host: Host, spawn: (host: Host) => Promise<SurfaceHandle>): Promise<Surface> {
    const handle = await spawn(host);
    if (handle.kind !== kind) {
      throw new Error(`Host ${host.kind} spawned ${handle.kind} for surface ${name}, expected ${kind}.`);
    }
    const surface = await this.attach(handle);
    this.entries.set(name, { surface, host, spawned: true });
    this.onLog(`Spawned ${kind} surface ${name} on host ${host.kind} at ${handle.cdpUrl}.`);
    return surface;
  }

  private async attach(handle: SurfaceHandle): Promise<Surface> {
    await waitForCdp(handle.cdpUrl, { timeoutMs: SURFACE_CDP_TIMEOUT_MS });
    const client = await this.connectSurface(handle);
    return { handle, client };
  }
}
