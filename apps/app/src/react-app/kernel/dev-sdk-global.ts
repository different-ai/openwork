import type { createClient } from "../../app/lib/opencode";

type OpencodeWrapperClient = ReturnType<typeof createClient>;

/**
 * Dev-only DevTools handle for the live opencode SDK surface.
 *
 * `createClient` mints ad-hoc clients against any base URL; `workspace`
 * carries the exact client + directory the active session route is using,
 * so console checks (tool.ids, mcp.status, session.messages) match what
 * sessions actually see.
 */
export type DevSdkGlobal = {
  url?: string;
  healthy?: boolean;
  createClient?: typeof createClient;
  workspace?: {
    directory: string;
    baseUrl: string;
    client: OpencodeWrapperClient;
  } | null;
};

declare global {
  interface Window {
    __OPENWORK_SDK__?: DevSdkGlobal;
  }
}

export function exposeDevSdkGlobal(partial: Partial<DevSdkGlobal>): void {
  if (!import.meta.env.DEV || typeof window === "undefined") return;
  window.__OPENWORK_SDK__ = { ...window.__OPENWORK_SDK__, ...partial };
}
