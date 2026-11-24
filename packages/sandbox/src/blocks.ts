import type { ImageRef, ProviderTimeout, SandboxHandle } from "./provider.js"

/** A completed process; a timeout throws SandboxError, never implies it was killed. */
export type RunResult = { exitCode: number; stdout: string; stderr: string }
export type RunSpec = ProviderTimeout & {
  command: string
  activity?: "work" | "maintenance"
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
  stat(handle: SandboxHandle, path: string, opts: ProviderTimeout): Promise<FileStat | null>
}
export interface SandboxPause {
  (handle: SandboxHandle, opts: ProviderTimeout): Promise<void>
}
export interface SandboxActivity {
  (handle: SandboxHandle, opts: ProviderTimeout): Promise<void>
}
export interface SandboxSnapshots {
  create(handle: SandboxHandle, name: string, opts: ProviderTimeout): Promise<ImageRef>
  destroy(image: ImageRef, opts: ProviderTimeout): Promise<void>
}

/** Objects are the capability claims: no duplicate booleans that can disagree with them. */
export interface SandboxBlocks {
  run?: SandboxRun
  files?: SandboxFiles
  pause?: SandboxPause
  activity?: SandboxActivity
  snapshots?: SandboxSnapshots
}
export type SandboxPlatform = {
  os: "linux" | "windows"
  isolation: "container" | "microvm" | "vm" | "unknown"
}
