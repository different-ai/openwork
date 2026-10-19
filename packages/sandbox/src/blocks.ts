import type { ImageRef, ProviderTimeout, SandboxHandle } from "./provider.js"

/** A completed process; a timeout throws SandboxError, never implies it was killed. */
export type RunResult = { exitCode: number; stdout: string; stderr: string }
export type RunSpec = ProviderTimeout & {
  command: string
  shell?: "sh" | "powershell"
  env?: Readonly<Record<string, string>>
  cwd?: string
}
export interface SandboxRun {
  (handle: SandboxHandle, spec: RunSpec): Promise<RunResult>
}
export type FileStat = { size: number; kind: "file" | "directory" }
export interface SandboxFiles {
  read(handle: SandboxHandle, path: string, opts: ProviderTimeout): Promise<Uint8Array>
  write(handle: SandboxHandle, path: string, bytes: Uint8Array, opts: ProviderTimeout & { mode?: number }): Promise<void>
  /** null means absent, not inaccessible. */
  stat(handle: SandboxHandle, path: string, opts: ProviderTimeout): Promise<FileStat | null>
}
export interface SandboxPause {
  /** Memory-preserving suspension. Resume with compute.start, not run. */
  (handle: SandboxHandle, opts: ProviderTimeout): Promise<void>
}
export interface SandboxSnapshots {
  /** Capture an instance, not build an image. Provider-specific image builds stay outside this block. */
  create(handle: SandboxHandle, name: string, opts: ProviderTimeout): Promise<ImageRef>
  /** Owner-driven cleanup; compute deletion never implicitly deletes a reusable image. */
  destroy(image: ImageRef, opts: ProviderTimeout): Promise<void>
}

/**
 * One way to reach a guest port from the machine that asked. Routes describe;
 * they never connect. `@openwork/sandbox-connect` races them and keeps the
 * first that answers, so one provider service failing (a preview proxy
 * answering 502) does not fail the caller.
 */
export type SandboxRoute = SandboxHttpsRoute | SandboxSshRoute
type SandboxRouteBase = {
  /** Short public name for logs, e.g. "daytona-preview". Never a URL or token. */
  label: string
  /** Headers to add to every request (a gateway cookie, a provider token). */
  access?: Readonly<Record<string, string>>
  /** Called once when the route is no longer needed, e.g. to revoke a token. */
  release?: () => Promise<void>
}
/** The provider's HTTPS edge: a preview URL or a bound domain. */
export type SandboxHttpsRoute = SandboxRouteBase & { kind: "https"; url: string }
/** The provider's SSH gateway, forwarding a guest port to local loopback. */
export type SandboxSshRoute = SandboxRouteBase & {
  kind: "ssh"
  host: string
  port?: number
  /** Providers put the access token in the SSH user, so this is a secret. */
  user: string
  /** Guest address to forward; host defaults to 127.0.0.1. */
  target: { host?: string; port: number }
}
export interface SandboxRoutes {
  /**
   * Every route the provider can offer to a guest port, with short-lived
   * credentials. A route that cannot be issued is left out, not thrown.
   */
  (handle: SandboxHandle, port: number, opts: ProviderTimeout & { ttlSeconds?: number }): Promise<SandboxRoute[]>
}

/** Objects are the capability claims: no duplicate booleans that can disagree with them. */
export interface SandboxBlocks {
  run?: SandboxRun
  files?: SandboxFiles
  pause?: SandboxPause
  snapshots?: SandboxSnapshots
  routes?: SandboxRoutes
}
export type SandboxPlatform = {
  os: "linux" | "windows"
  isolation: "container" | "microvm" | "vm" | "unknown"
}
