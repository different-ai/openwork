import type { DenFetchResult, DenSession, NativeConnectorInput } from "@openwork/behaviors";
import type { AttachedSurface, Surface } from "@openwork/cdp";
import type { StartMockMcpOptions } from "@openwork/labs";
import type { DesktopHandle } from "@openwork/hosts";
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
  profileDir?: string;
  name?: string;
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

/** Framework-free arrangement contract implemented by the testkit world fixture. */
export interface Seed {
  den(options?: Omit<ServerOptions, "place">): Promise<Den>;
  desktop(options?: SeedDesktopOptions): Promise<App | DesktopHandle>;
  web(options: SeedWebOptions): Promise<AttachedSurface>;
  workspace(app: Surface, path?: string): Promise<{ workspaceId: string; route: string }>;
  session(app: Surface, options?: { title?: string }): Promise<{ sessionId: string; title: string }>;
  sessions(app: Surface, titles: readonly string[]): Promise<{ sessionId: string; title: string }[]>;
  signIn(app: Surface, member: DenSession): Promise<void>;
  api(session: DenSession, path: string, init?: RequestInit): Promise<DenFetchResult>;
  orgConnection(admin: DenSession, input: OrgConnectionInput): Promise<{ id: string; name: string }>;
  nativeConnector(admin: DenSession, input: NativeConnectorInput): Promise<{ id: string; name: string }>;
  mock(options?: StartMockMcpOptions): MockBoot;
  faultProxy(den: Den): Promise<FaultProxy>;
  tmpPath(label: string): string;
  composerText(app: Surface, text: string): Promise<void>;
  /** Migration-only raw write escape hatch. New specs must not use it. */
  evalIn(surface: Surface, expression: string): Promise<unknown>;
}
