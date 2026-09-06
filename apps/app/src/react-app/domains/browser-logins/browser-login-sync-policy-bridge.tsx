import { useEffect } from "react";

import { getBrowserLoginsBridge, useBrowserLoginSync } from "./use-browser-login-sync";

/** Keeps main-process policy enforcement current for the full Desktop lifetime. */
export function BrowserLoginSyncPolicyBridge() {
  useBrowserLoginSync();
  useEffect(() => () => {
    // The enterprise activation gate can unmount the policy provider. Stop the
    // main-process worker rather than letting its last grant outlive the gate.
    void getBrowserLoginsBridge()?.setPolicyAllowed(false);
  }, []);
  return null;
}
