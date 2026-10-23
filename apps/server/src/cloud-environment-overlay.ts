import { createHash } from "node:crypto";

/**
 * Organization environment variables the OpenCode engines run with.
 *
 * Written by CloudEnvironmentSync. Every engine spawn (the v1 primary, pool
 * standbys and the v2 preview) starts with it, and a running v2 engine's
 * plugin fetches it live over the loopback provider session bridge. Values
 * apply after the person's own saved and shell variables: an
 * admin-provisioned value can't be overridden on the device.
 *
 * Process-local and in memory only: values never touch disk here.
 */

let overlay: Readonly<Record<string, string>> = Object.freeze({});

export function cloudEnvironmentOverlay(): Readonly<Record<string, string>> {
  return overlay;
}

export function setCloudEnvironmentOverlay(next: Record<string, string>): void {
  overlay = Object.freeze({ ...next });
}

/** A stable fingerprint of an environment, to tell whether an engine has it. */
export function hashEnvironment(environment: Readonly<Record<string, string>>): string {
  const hash = createHash("sha256");
  for (const key of Object.keys(environment).sort()) hash.update(`${key}\u0000${environment[key]}\u0000`);
  return hash.digest("hex");
}

/** What the running v2 engine's plugin applies: the values and their fingerprint. */
export function cloudEnvironmentSnapshot(): { digest: string; env: Readonly<Record<string, string>> } {
  return { digest: hashEnvironment(overlay), env: overlay };
}
