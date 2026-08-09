import type { SurfaceHandle, SurfaceKind } from "@openwork/cdp";

export type { SurfaceHandle, SurfaceKind } from "@openwork/cdp";

export interface ElectronSurfaceOptions {
  profile?: "fresh" | "shared";
  /** Exact caller-owned profile root. Local hosts preserve it on disposal. */
  profileDir?: string;
  bootstrap?: {
    baseUrl: string;
    apiBaseUrl?: string;
    requireSignin?: boolean;
  };
  env?: Record<string, string>;
}

export interface ChromeSurfaceOptions {
  profile?: "fresh" | "shared";
  startUrl?: string;
  headless?: boolean;
}

export interface DenServiceOptions {
  orgMode?: "single_org" | "multi_org";
  seed?: "acme" | "none";
}

export interface DenServiceHandle {
  webUrl: string;
  apiUrl: string;
  orgMode: "single_org" | "multi_org";
  hostKind: string;
}

export type ShareLinks = { label: string; url: string }[];

export interface Host {
  kind: string;
  /**
   * The repo/workspace root ON THIS HOST.
   *
   * A spec that passes `process.cwd()` as a workspace path is only correct when
   * the driver and the app share a filesystem. Drive a sandbox from a laptop and
   * the app is asked to open a directory that does not exist there — observed as
   * onboarding hanging on "Power your first task" with no error. Ask the host.
   */
  workspaceRoot: string;
  previewUrl?(port: number): Promise<string>;
  spawnElectron(name: string, opts?: ElectronSurfaceOptions): Promise<SurfaceHandle>;
  spawnChrome(name: string, opts?: ChromeSurfaceOptions): Promise<SurfaceHandle>;
  startDen?(opts?: DenServiceOptions): Promise<DenServiceHandle>;
  share?(): Promise<ShareLinks>;
  disposeSurface(handle: SurfaceHandle): Promise<void>;
}

export type DisposableHost = Host & AsyncDisposable & { stop(): Promise<void> };
