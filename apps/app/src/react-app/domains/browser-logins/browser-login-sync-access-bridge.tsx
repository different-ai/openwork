import { useEnterpriseActivationRequired } from "@/react-app/domains/cloud/enterprise-activation-gate";
import { useBrowserLoginSync } from "./use-browser-login-sync";

/** Revokes main-process access when Desktop enters an organization context. */
export function BrowserLoginSyncAccessBridge() {
  if (useEnterpriseActivationRequired()) return null;
  return <ActivatedBrowserLoginSyncAccessBridge />;
}

function ActivatedBrowserLoginSyncAccessBridge() {
  useBrowserLoginSync();
  return null;
}
