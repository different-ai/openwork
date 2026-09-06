import { openworkPluginPath } from "./openwork-extensions-plugin-path.js";
export function managedPolicyPluginPath(next = false): string {
  return openworkPluginPath(next ? "managed-policy-next" : "managed-policy");
}
