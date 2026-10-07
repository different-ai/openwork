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

/** Objects are the capability claims: no duplicate booleans that can disagree with them. */
export interface SandboxBlocks {
  run?: SandboxRun
  files?: SandboxFiles
  pause?: SandboxPause
  snapshots?: SandboxSnapshots
}
export type SandboxPlatform = {
  os: "linux" | "windows"
  isolation: "container" | "microvm" | "vm" | "unknown"
}
