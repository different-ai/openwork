import type { SurfaceHandle, SurfaceKind } from "@openwork/cdp";

export type { SurfaceHandle, SurfaceKind } from "@openwork/cdp";

export interface ElectronSurfaceOptions {
  profile?: "fresh" | "shared";
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
  previewUrl?(port: number): Promise<string>;
  spawnElectron(name: string, opts?: ElectronSurfaceOptions): Promise<SurfaceHandle>;
  spawnChrome(name: string, opts?: ChromeSurfaceOptions): Promise<SurfaceHandle>;
  startDen?(opts?: DenServiceOptions): Promise<DenServiceHandle>;
  share?(): Promise<ShareLinks>;
  disposeSurface(handle: SurfaceHandle): Promise<void>;
}

export type DisposableHost = Host & AsyncDisposable & { stop(): Promise<void> };
