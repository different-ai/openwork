import type { DenFetchResult, DenSession, NativeConnectorInput } from "@openwork/behaviors";
import type { AttachedSurface, CdpFunctionArgument, Surface } from "@openwork/cdp";
import type { StartMockMcpOptions } from "@openwork/labs";
import type { DaytonaExec, DesktopHandle } from "@openwork/hosts";
import type { App } from "./desktop-app.ts";
import type { Den, ServerOptions } from "./den.ts";
import type { FaultProxy } from "./faults.ts";
import type { MockBoot } from "./mock.ts";

export interface SeedDesktopOptions {
  den?: Den;
  as?: string;
  signIn?: false;
  model?: string;
  workspacePath?: string;
  /** Arrange a previously activated private-Den installation; does not test activation. */
  enterpriseActivated?: boolean;
  profileDir?: string;
  name?: string;
  /** Extra environment for this isolated Electron process. */
  env?: Record<string, string>;
}

export interface SeedWebOptions {
  den: Den;
  signedInAs?: DenSession | "admin" | string;
  startPath?: string;
  headless?: boolean;
  viewport?: { width: number; height: number; deviceScaleFactor?: number };
}

export interface OrgConnectionInput {
  name: string;
  url: string;
  authType: string;
  credentialMode: string;
  access: { orgWide: boolean };
}

export type SeedDenLinkProfile = "baseline" | "vpn-flaky-emulated";
export type SeedDenLinkClient = "public-preview" | "sandbox-loopback";
export type SeedDenLinkRule = { pathPrefix?: string; times?: number; everyNth?: number } & (
  | { kind: "latency"; delayMs: number; jitterMs?: number }
  | { kind: "status"; statusCode: number; body?: unknown }
  | { kind: "reset" }
  | { kind: "stall" }
);

export interface SeedDenLinkOptions {
  sandboxId?: string;
  client?: SeedDenLinkClient;
  port?: number;
  adminPort?: number;
  daytonaExec?: DaytonaExec;
}

export interface SeedDenLink extends AsyncDisposable {
  ref: Den["ref"];
  admin: {
    phase(name: string, profile?: SeedDenLinkProfile): Promise<void>;
    rules(rules: SeedDenLinkRule[]): Promise<void>;
    bandwidth(bytesPerSec: number | null): Promise<void>;
    offline(durationMs: number): Promise<void>;
    clear(): Promise<void>;
    requests(): Promise<{
      requests: Array<{
        method: string;
        path: string;
        status: number;
        faulted: boolean;
        fault?: string;
        phase: string;
        profile: SeedDenLinkProfile;
        at: number;
      }>;
      refusedConnections: Record<string, number>;
      phase: string;
      profile: SeedDenLinkProfile;
    }>;
    stats(): Promise<{
      requests: number;
      faults: number;
      refusedConnections: number;
      phase: string;
      profile: SeedDenLinkProfile;
    }>;
    health(): Promise<{ ok: boolean; phase: string; offline: boolean }>;
  };
}

/** Framework-free arrangement contract implemented by the testkit world fixture. */
export interface Seed {
  den(options?: Omit<ServerOptions, "place">): Promise<Den>;
  desktop(options?: SeedDesktopOptions): Promise<App | DesktopHandle>;
  web(options: SeedWebOptions): Promise<AttachedSurface>;
  /** Ensure a selected workspace; create:true explicitly creates another workspace. */
  workspace(app: Surface, path?: string, options?: { create?: boolean }): Promise<{ workspaceId: string; route: string }>;
  session(app: Surface, options?: { title?: string }): Promise<{ sessionId: string; title: string }>;
  sessions(app: Surface, titles: readonly string[]): Promise<{ sessionId: string; title: string }[]>;
  signIn(app: Surface, member: DenSession, identity: string): Promise<void>;
  api(session: DenSession, path: string, init?: RequestInit): Promise<DenFetchResult>;
  orgConnection(admin: DenSession, input: OrgConnectionInput): Promise<{ id: string; name: string }>;
  nativeConnector(admin: DenSession, input: NativeConnectorInput): Promise<{ id: string; name: string }>;
  mock(options?: StartMockMcpOptions): MockBoot;
  faultProxy(den: Den): Promise<FaultProxy>;
  denLink(den: Den, options?: SeedDenLinkOptions): Promise<SeedDenLink>;
  tmpPath(label: string): string;
  composerText(app: Surface, text: string): Promise<void>;
  /** Migration-only raw write escape hatch. New specs must not use it. */
  evalIn(surface: Surface, expression: string, options?: { args?: readonly CdpFunctionArgument[]; awaitPromise?: boolean; timeoutMs?: number }): Promise<unknown>;
}
