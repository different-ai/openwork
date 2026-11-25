/**
 * The slice of microsandbox the provider drives, as plain data. The provider
 * maps the OpenWork sandbox contract onto this; `native-driver.ts` maps this
 * onto the `microsandbox` SDK. Tests replace it with an in-memory guest.
 */

export type MicrosandboxMount = {
  hostPath: string
  guestPath: string
  access: "ro" | "rw"
}

/**
 * Outbound network access. There is no implicit default: microsandbox allows
 * all egress unless a policy is set, so the adapter always sets one.
 */
export type MicrosandboxNetwork =
  | { egress: "none" }
  | { egress: "allow-list"; domains: readonly string[] }

export type GuestIdentity = {
  name: string
  id: string
}

export type GuestStatus = "created" | "starting" | "running" | "draining" | "paused" | "stopped" | "crashed"

export type GuestInfo = GuestIdentity & {
  status: GuestStatus
  labels: Readonly<Record<string, string>>
}

export type GuestConfig = {
  name: string
  image: string
  cpus?: number
  memoryMib?: number
  diskMib?: number
  env: Readonly<Record<string, string>>
  labels: Readonly<Record<string, string>>
  mounts: readonly MicrosandboxMount[]
  network: MicrosandboxNetwork
  ports: readonly { hostPort: number; guestPort: number }[]
  idleTimeoutSeconds?: number
  ephemeral: boolean
}

export type GuestRun = {
  command: string
  cwd?: string
  env: Readonly<Record<string, string>>
  timeoutMs: number
}

export type GuestFileStat = { size: number; kind: "file" | "directory" | "symlink" | "other" }

/**
 * Errors carry a `code`: the microsandbox SDK's (`sandboxNotFound`,
 * `sandboxAlreadyExists`, `execTimeout`, …) or one a driver raises itself
 * (`createCancelled`, `portInUse`, `sandboxReplaced`, `notLocal`).
 * `errors.ts` maps it to the OpenWork taxonomy.
 */
export interface MicrosandboxDriver {
  create(config: GuestConfig, timeoutMs: number, onProgress?: (event: import("microsandbox").CreationProgress) => void): Promise<GuestInfo>
  get(name: string): Promise<GuestInfo | null>
  list(labels: Readonly<Record<string, string>>): Promise<GuestInfo[]>
  start(guest: GuestIdentity): Promise<void>
  resume(guest: GuestIdentity): Promise<void>
  pause(guest: GuestIdentity): Promise<void>
  stop(guest: GuestIdentity, timeoutMs: number): Promise<void>
  destroy(guest: GuestIdentity, timeoutMs: number): Promise<void>
  run(guest: GuestIdentity, spec: GuestRun): Promise<{ exitCode: number; stdout: string; stderr: string }>
  readFile(guest: GuestIdentity, path: string): Promise<Uint8Array>
  writeFile(guest: GuestIdentity, path: string, bytes: Uint8Array): Promise<void>
  stat(guest: GuestIdentity, path: string): Promise<GuestFileStat | null>
}

/** Raised by a driver for conditions the SDK does not report itself. */
export class MicrosandboxDriverError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = "MicrosandboxDriverError"
    this.code = code
  }
}
