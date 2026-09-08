/**
 * Provider-neutral contract between Den and the host that runs an OpenWork
 * Cloud sandbox (Daytona today; Fly Machines, Firecracker, Kubernetes, or a
 * local process tomorrow).
 *
 * Den's lifecycle policy (provision, wake, recycle, idle stop, prewarm) is
 * written against this contract only. A provider package implements it and
 * must pass `sandboxProviderConformanceCases` before Den can select it.
 *
 * Requirements the shapes below encode:
 * 1. Capability negotiation: the orchestrator adapts to `describe()`.
 * 2. Opaque references: Den persists `SandboxRef.ref` as JSON and never
 *    interprets it.
 * 3. Normalized state and error taxonomy: no message-string matching outside a
 *    provider package (see `errors.ts`).
 * 4. Endpoint abstraction with expiry: consumers learn `kind`/`expiresAt`,
 *    never a host name.
 * 5. Exec with logs and exit codes, so bootstrap failures stay diagnosable.
 * 6. Storage attach; checkpoint metadata is owned by Den, never probed with
 *    compute.
 * 7. Idempotent create: a retried `create` with the same `idempotencyKey` must
 *    either return the existing instance or throw `conflict`, never make two.
 */

export type ProviderEndpointKind = "signed-expiring" | "stable" | "den-tunnel"

export type ProviderCapabilities = {
  /** A stopped instance keeps its disk and can be started again. */
  stopResume: boolean
  /** Storage can outlive the instance (volumes, PVCs, external checkpoints). */
  persistentStorage: boolean
  /** Wake restores memory state; the bootstrap can be skipped on resume. */
  memorySnapshotRestore: boolean
  /** The host can hold pre-created instances for instant assignment. */
  warmPool: boolean
  endpointKind: ProviderEndpointKind
  /** `exec` is implemented; every current provider needs it for the bootstrap. */
  exec: boolean
  regions: readonly string[]
}

export type SandboxState =
  | "creating"
  | "running"
  | "stopping"
  | "stopped"
  | "archived"
  | "missing"
  | "error"

/** What the host should boot. Daytona: snapshot name. OCI hosts: image digest. */
export type ImageRef = {
  id: string
  version: string
}

/** Opaque to Den. Persisted as JSON, echoed back to the same provider. */
export type SandboxRef = {
  providerId: string
  ref: Readonly<Record<string, string>>
}

export type VolumeRef = {
  providerId: string
  id: string
  name: string
}

export type StorageAttachment = {
  volume: VolumeRef
  mountPath: string
  subpath?: string
}

export type SandboxResources = {
  cpu: number
  memoryGb: number
  diskGb: number
}

export type SandboxLifecyclePolicy = {
  autoStopMinutes?: number
  autoArchiveMinutes?: number
  autoDeleteMinutes?: number
}

export type SandboxSpec = {
  workerId: string
  /**
   * Stable per worker and image version. Providers map it to whatever makes a
   * create idempotent on their side (a name, a label, a request token).
   */
  idempotencyKey: string
  /** `null` asks the provider for its configured base image. */
  image: ImageRef | null
  resources?: SandboxResources
  labels: Readonly<Record<string, string>>
  env: Readonly<Record<string, string>>
  storage: readonly StorageAttachment[]
  exposePorts: readonly number[]
  lifecycle?: SandboxLifecyclePolicy
  /** Short-lived helper instance (cleanup, probes); never adopted as a worker. */
  ephemeral?: boolean
  public?: boolean
}

export type SandboxHandle = {
  ref: SandboxRef
  state: SandboxState
  region: string | null
  /** When `state` was last read from the host; the orchestrator caches on it. */
  observedAt: number
}

export type ExecSpec = {
  command: string
  /** Return once the process is started instead of waiting for exit. */
  detach: boolean
  timeoutMs: number
  /** Provider-visible grouping for log retrieval (Daytona sessions). */
  sessionId?: string
}

export interface ExecHandle {
  id: string
  /** `null` while the process is still running. */
  exitCode(): Promise<number | null>
  logs(): Promise<{ stdout: string; stderr: string }>
}

export type Endpoint = {
  url: string
  /** `null` for stable endpoints. */
  expiresAt: Date | null
  kind: ProviderEndpointKind
}

export type ProviderTimeout = {
  timeoutMs: number
}

export type SandboxQuery = {
  idempotencyKey?: string
  labels?: Readonly<Record<string, string>>
}

export interface SandboxStorage {
  /** Idempotent; resolves once the volume is usable for attachment. */
  ensureVolume(name: string, opts: ProviderTimeout): Promise<VolumeRef>
  /** Erase worker data at deprovision; must not touch other subpaths. */
  eraseSubpaths(volume: VolumeRef, subpaths: readonly string[], opts: ProviderTimeout): Promise<void>
  /**
   * Optional metadata probe. Den keeps its own checkpoint ledger; this exists
   * only for records that predate the ledger and may cost compute.
   */
  exists?(volume: VolumeRef, path: string, opts: ProviderTimeout): Promise<boolean>
}

export interface SandboxProvider {
  readonly id: string
  describe(): ProviderCapabilities
  /** The image new instances should boot, or `null` when the provider has no pin. */
  currentImage(): ImageRef | null
  /** Throws `conflict` when `idempotencyKey` already names a live instance. */
  create(spec: SandboxSpec, opts: ProviderTimeout): Promise<SandboxHandle>
  find(query: SandboxQuery): Promise<SandboxHandle | null>
  /** `null` for a missing instance; never throws `not_found`. */
  get(ref: SandboxRef): Promise<SandboxHandle | null>
  /** One state refresh. Must be cheap; the orchestrator decides how often. */
  inspect(handle: SandboxHandle): Promise<SandboxHandle>
  start(handle: SandboxHandle, opts: ProviderTimeout): Promise<void>
  stop(handle: SandboxHandle, opts: ProviderTimeout): Promise<void>
  destroy(handle: SandboxHandle, opts: ProviderTimeout): Promise<void>
  exec(handle: SandboxHandle, spec: ExecSpec): Promise<ExecHandle>
  endpoint(handle: SandboxHandle, port: number, opts?: { ttlSeconds?: number }): Promise<Endpoint>
  readonly storage: SandboxStorage
}
