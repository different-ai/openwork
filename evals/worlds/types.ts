import type { DenFetchResult, DenSession } from "@openwork/behaviors";
import type { AttachedSurface, Surface } from "@openwork/cdp";
import type { App, Den, ServerOptions } from "@openwork/env";
import type { DesktopHandle } from "@openwork/hosts";

export interface WorldSeed {
  den(options?: Omit<ServerOptions, "place">): Promise<Den>;
  desktop(options?: { name?: string }): Promise<App | DesktopHandle>;
  web(options: {
    den: Den;
    startPath?: string;
    headless?: boolean;
    viewport?: { width: number; height: number; deviceScaleFactor?: number };
  }): Promise<AttachedSurface>;
  workspace(app: Surface, path?: string): Promise<{ workspaceId: string; route: string }>;
  session(app: Surface, options?: { title?: string }): Promise<{ sessionId: string; title: string }>;
  tmpPath(label: string): string;
  api(session: DenSession, path: string, init?: RequestInit): Promise<DenFetchResult>;
}
