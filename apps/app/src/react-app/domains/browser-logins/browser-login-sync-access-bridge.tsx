import { useBrowserLoginSync } from "./use-browser-login-sync";

/** Revokes main-process access when Desktop enters an organization context. */
export function BrowserLoginSyncAccessBridge() {
  useBrowserLoginSync();
  return null;
}
