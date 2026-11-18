import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix, resolve } from "node:path";
import type { MicrosandboxMount } from "@openwork/sandbox-microsandbox";

type Grant = { path: string; effect: "allow" | "ask" | "deny" };

function inside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(`${parent}/`);
}

/** Authorized Folders is permission.external_directory, not ServerConfig.authorizedRoots. */
export function sandboxMountGrants(workspace: string, externalDirectory: Readonly<Record<string, unknown>>, readOnly = false): MicrosandboxMount[] {
  if (process.platform === "win32") throw new Error("Local microsandbox mounts require macOS or Linux.");
  const root = resolve(workspace);
  if (root === "/") throw new Error("The host root cannot be a sandbox workspace.");
  const rules: Grant[] = [];
  for (const [pattern, value] of Object.entries(externalDirectory)) {
    if (value !== "allow" && value !== "ask" && value !== "deny") {
      throw new Error("An Authorized Folders permission cannot be represented by a bind mount.");
    }
    if (pattern === "*" || pattern === "**") {
      if (value === "allow") throw new Error("Authorize concrete folders, not every host directory, before starting a sandbox.");
      rules.push({ path: "/", effect: value });
      continue;
    }
    // The Authorized Folders editor writes absolute /folder/* entries. Arbitrary glob policies cannot become mounts.
    const path = pattern.endsWith("/*") ? pattern.slice(0, -2) : "";
    if (!path || !isAbsolute(path) || /[?*\[\]{}!]/.test(path) || path === "/" || posix.normalize(path) !== path) {
      throw new Error("The sandbox needs concrete Authorized Folders entries; this external-directory pattern cannot be mounted safely.");
    }
    rules.push({ path, effect: value });
  }
  const folders = new Set([root]);
  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];
    if (rule.effect !== "allow") continue;
    const later = rules.slice(index + 1);
    if (later.some(next => next.effect !== "allow" && (next.path === "/" || inside(rule.path, next.path)))) continue;
    if (later.some(next => next.effect !== "allow" && inside(next.path, rule.path))) {
      throw new Error("An Authorized Folder contains a restricted subtree; a live bind mount cannot enforce that exception.");
    }
    folders.add(rule.path);
  }
  // A bind mount of the workspace must not grant a denied child through an Authorized Folders exception either.
  if (rules.some(rule => rule.effect !== "allow" && rule.path !== "/" && inside(rule.path, root))) {
    throw new Error("The workspace contains a restricted subtree that cannot be enforced by a live bind mount.");
  }
  return [...folders].sort().map(path => ({ hostPath: path, guestPath: path, access: readOnly ? "ro" : "rw" }));
}

/** Resolve existing ancestors too, so a not-yet-created denied child retains its canonical parent. */
async function canonicalCandidate(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonicalCandidate(parent), basename(path));
  }
}

export async function resolveSandboxMounts(mounts: readonly MicrosandboxMount[], excluded: readonly string[], externalDirectory: Readonly<Record<string, unknown>> = {}): Promise<MicrosandboxMount[]> {
  const protectedPaths = await Promise.all(excluded.map(path => canonicalCandidate(resolve(path))));
  const restrictions = await Promise.all(Object.entries(externalDirectory)
    .filter(([path, value]) => value !== "allow" && path.startsWith("/") && path.endsWith("/*"))
    .map(([path]) => canonicalCandidate(path.slice(0, -2))));
  const resolved: MicrosandboxMount[] = [];
  for (const mount of mounts) {
    const hostPath = await realpath(mount.hostPath);
    if (!(await stat(hostPath)).isDirectory()) throw new Error("An Authorized Folder is not a directory.");
    if (hostPath === "/" || protectedPaths.some(path => inside(path, hostPath) || inside(hostPath, path))) {
      throw new Error("A sandbox mount would expose protected runtime state. Remove that Authorized Folder.");
    }
    if (restrictions.some(path => inside(path, hostPath) || inside(hostPath, path))) {
      throw new Error("A sandbox bind aliases a restricted Authorized Folder subtree.");
    }
    // Preserve the path the model uses even when macOS canonicalizes /var to /private/var on the host.
    resolved.push({ ...mount, hostPath });
  }
  return resolved;
}

export function sandboxMountFingerprint(mounts: readonly MicrosandboxMount[]): string {
  return createHash("sha256").update(JSON.stringify(mounts)).digest("hex");
}
