import { createHash } from "node:crypto";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { lstat, mkdir, realpath, stat } from "node:fs/promises";
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

export class SandboxFolderError extends Error {
  constructor(readonly folder: string, cause?: unknown) {
    super(`The sandbox couldn't connect to “${basename(folder) || folder}”.`, { cause });
  }
}

function restrictionPaths(externalDirectory: Readonly<Record<string, unknown>>): string[] {
  return Object.entries(externalDirectory)
    .filter(([path, value]) => value !== "allow" && path.startsWith("/") && path.endsWith("/*"))
    .map(([path]) => path.slice(0, -2));
}

function validateMount(mount: MicrosandboxMount, hostPath: string, directory: boolean, protectedPaths: string[], restrictions: string[]): MicrosandboxMount {
  if (!directory) throw new SandboxFolderError(mount.guestPath);
  if (hostPath === "/" || protectedPaths.some(path => inside(path, hostPath) || inside(hostPath, path))) {
    throw new Error("A sandbox mount would expose protected runtime state. Remove that Authorized Folder.");
  }
  if (restrictions.some(path => inside(path, hostPath) || inside(hostPath, path))) {
    throw new Error("A sandbox bind aliases a restricted Authorized Folder subtree.");
  }
  return { ...mount, hostPath };
}

function canonicalCandidateSync(path: string): string {
  try { return realpathSync(path); }
  catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(canonicalCandidateSync(parent), basename(path));
  }
}

/**
 * Folders inside a writable mount that the host acts on by itself: git reads `.git/config` (an
 * `core.fsmonitor` command runs on any status) and the engine loads `.opencode` plugins once the
 * sandbox is no longer required. Each one that exists as a real directory is mounted again read-only
 * over the writable bind, so code in the sandbox cannot plant something that later runs on the host.
 */
export const SANDBOX_HOST_CONFIG_FOLDERS = [".git", ".opencode"] as const;

function hostConfigOverlays(mount: MicrosandboxMount, isDirectory: (path: string) => boolean): MicrosandboxMount[] {
  if (mount.access !== "rw") return [];
  return SANDBOX_HOST_CONFIG_FOLDERS
    .filter(name => isDirectory(join(mount.hostPath, name)))
    .map(name => ({ hostPath: join(mount.hostPath, name), guestPath: posix.join(mount.guestPath, name), access: "ro" as const }));
}

/** Whether a mount is one of those read-only folders rather than a folder the person granted. */
export function isSandboxHostConfigOverlay(mount: MicrosandboxMount, mounts: readonly MicrosandboxMount[]): boolean {
  return mount.access === "ro" && (SANDBOX_HOST_CONFIG_FOLDERS as readonly string[]).includes(posix.basename(mount.guestPath))
    && mounts.some(parent => parent.access === "rw" && parent.guestPath === posix.dirname(mount.guestPath));
}

function realDirectorySync(path: string) {
  try { return lstatSync(path).isDirectory(); } catch { return false; }
}

/** A writable mount comes before the read-only folders inside it. */
function withHostConfigOverlays(mounts: readonly MicrosandboxMount[], directories: ReadonlySet<string>): MicrosandboxMount[] {
  return [...mounts, ...mounts.flatMap(mount => hostConfigOverlays(mount, path => directories.has(path)))]
    .sort((a, b) => a.guestPath < b.guestPath ? -1 : a.guestPath > b.guestPath ? 1 : 0);
}

/**
 * Creates the workspace's `.opencode` folder when it is missing, so it can be mounted read-only.
 * A missing `.git` is left alone: an empty one would change what git treats as the repository.
 */
export async function prepareSandboxHostConfigFolders(workspace: string, readOnly: boolean): Promise<void> {
  if (readOnly) return;
  const folder = join(resolve(workspace), ".opencode");
  const existing = await lstat(folder).catch(() => null);
  if (!existing) await mkdir(folder).catch(error => { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; });
}

export function sandboxMountFingerprintForWrite(directory: string, grants: Record<string, unknown>, readOnly: boolean, excluded: readonly string[]): string {
  const mounts = sandboxMountGrants(directory, grants, readOnly);
  const protectedPaths = excluded.map(path => canonicalCandidateSync(resolve(path)));
  const restrictions = restrictionPaths(grants).map(canonicalCandidateSync);
  const resolved = mounts.map(mount => {
    const path = realpathSync(mount.hostPath);
    return validateMount(mount, path, statSync(path).isDirectory(), protectedPaths, restrictions);
  });
  const directories = new Set(resolved.flatMap(mount => SANDBOX_HOST_CONFIG_FOLDERS.map(name => join(mount.hostPath, name))).filter(realDirectorySync));
  return sandboxMountFingerprint(withHostConfigOverlays(resolved, directories));
}

export async function resolveSandboxMounts(mounts: readonly MicrosandboxMount[], excluded: readonly string[], externalDirectory: Readonly<Record<string, unknown>> = {}): Promise<MicrosandboxMount[]> {
  const protectedPaths = await Promise.all(excluded.map(path => canonicalCandidate(resolve(path))));
  const restrictions = await Promise.all(restrictionPaths(externalDirectory).map(canonicalCandidate));
  const resolved: MicrosandboxMount[] = [];
  for (const mount of mounts) {
    const hostPath = await realpath(mount.hostPath).catch(error => { throw new SandboxFolderError(mount.guestPath, error); });
    const metadata = await stat(hostPath).catch(error => { throw new SandboxFolderError(mount.guestPath, error); });
    resolved.push(validateMount(mount, hostPath, metadata.isDirectory(), protectedPaths, restrictions));
  }
  const candidates = resolved.flatMap(mount => SANDBOX_HOST_CONFIG_FOLDERS.map(name => join(mount.hostPath, name)));
  const found = await Promise.all(candidates.map(async path => (await lstat(path).catch(() => null))?.isDirectory() ? path : null));
  return withHostConfigOverlays(resolved, new Set(found.filter((path): path is string => path !== null)));
}

export function sandboxMountFingerprint(mounts: readonly MicrosandboxMount[]): string {
  return createHash("sha256").update(JSON.stringify(mounts)).digest("hex");
}
