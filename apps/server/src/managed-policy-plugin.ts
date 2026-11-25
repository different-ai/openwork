import { openworkPluginPath } from "./openwork-extensions-plugin-path.js";
import { fileURLToPath } from "node:url";
export function managedPolicyPluginPath(next = false): string {
  return openworkPluginPath(next ? "managed-policy-next" : "managed-policy");
}

export function isManagedPolicyPlugin(value: string): boolean {
  let path = value;
  if (value.startsWith("file:")) {
    try { path = fileURLToPath(value); } catch { return false; }
  }
  return path === managedPolicyPluginPath() || path === managedPolicyPluginPath(true);
}
