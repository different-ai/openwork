import { openworkPluginPath } from "./openwork-extensions-plugin-path.js";
import { fileURLToPath } from "node:url";
export function managedPolicyPluginPath(next = false): string {
  return openworkPluginPath(next ? "managed-policy-next" : "managed-policy");
}

// Remove only our own registrations, including file-URL copies persisted by
// older runtime configs. A third-party plugin with the same basename is valid.
export function isManagedPolicyPlugin(value: string): boolean {
  let path = value;
  if (value.startsWith("file:")) {
    try { path = fileURLToPath(value); } catch { return false; }
  }
  return path === managedPolicyPluginPath() || path === managedPolicyPluginPath(true);
}
