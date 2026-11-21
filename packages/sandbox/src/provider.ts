import type { SandboxBlocks, SandboxPlatform } from "./blocks.js"

export type ProviderEndpointKind = "signed-expiring" | "stable" | "den-tunnel"

export type ProviderCapabilities = {
  stopResume: boolean
  callsOffPause?: boolean
  persistentStorage: boolean
  memorySnapshotRestore: boolean
  warmPool: boolean
  endpointKind: ProviderEndpointKind
  exec: boolean
  regions: readonly string[]
  platform?: SandboxPlatform
  createEnvironment?: boolean
  endpoints?: boolean
  detachedExec?: boolean
}

export type SandboxState =
  | "creating"
  | "starting"
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
  autoPauseMinutes?: number
  autoArchiveMinutes?: number
  autoDeleteMinutes?: number
}

export type SandboxSpec = {
  workerId?: string
  idempotencyKey: string
  image: ImageRef | null
  resources?: SandboxResources
  labels: Readonly<Record<string, string>>
  env: Readonly<Record<string, string>>
  storage: readonly StorageAttachment[]
  exposePorts: readonly number[]
  lifecycle?: SandboxLifecyclePolicy
  ephemeral?: boolean
  public?: boolean
}

export type SandboxHandle = {
  ref: SandboxRef
  name?: string
  state: SandboxState
  region: string | null
  observedAt: number
}

export type ExecSpec = ({ command: string; script?: never } | { script: string; command?: never }) & {
  detach: boolean
  timeoutMs: number
  sessionId?: string
}

export interface ExecHandle {
  id: string
  exitCode(): Promise<number | null>
  logs(): Promise<{ stdout: string; stderr: string }>
}

export type Endpoint = {
  url: string
  expiresAt: Date | null
  kind: ProviderEndpointKind
}

export type ProviderTimeout = {
  timeoutMs: number
}

export type SandboxCreateProgress =
  | { kind: "resolving" | "complete" }
  | { kind: "resolved"; totalDownloadBytes: number | null }
  | { kind: "layerDownloadProgress" | "layerDownloadComplete"; layerIndex: number; downloadedBytes: number }
  | { kind: "startup"; phase: string; completedBytes: number; totalBytes?: number | null }

export type SandboxCreateOptions = ProviderTimeout & { onProgress?: (event: SandboxCreateProgress) => void }

export type SandboxQuery = {
  idempotencyKey?: string
  labels?: Readonly<Record<string, string>>
}

export interface SandboxStorage {
  ensureVolume(name: string, opts: ProviderTimeout): Promise<VolumeRef>
  eraseSubpaths(volume: VolumeRef, subpaths: readonly string[], opts: ProviderTimeout): Promise<void>
  exists?(volume: VolumeRef, path: string, opts: ProviderTimeout): Promise<boolean>
}

export interface SandboxProvider {
  readonly id: string
  describe(): ProviderCapabilities
  currentImage(): ImageRef | null
  create(spec: SandboxSpec, opts: SandboxCreateOptions): Promise<SandboxHandle>
  find(query: SandboxQuery): Promise<SandboxHandle | null>
  list(query: SandboxQuery): Promise<SandboxHandle[]>
  get(ref: SandboxRef): Promise<SandboxHandle | null>
  inspect(handle: SandboxHandle): Promise<SandboxHandle>
  start(handle: SandboxHandle, opts: ProviderTimeout): Promise<void>
  stop(handle: SandboxHandle, opts: ProviderTimeout): Promise<void>
  destroy(handle: SandboxHandle, opts: ProviderTimeout): Promise<void>
  exec(handle: SandboxHandle, spec: ExecSpec): Promise<ExecHandle>
  endpoint(handle: SandboxHandle, port: number, opts?: { ttlSeconds?: number }): Promise<Endpoint>
  readonly storage: SandboxStorage
  readonly blocks?: SandboxBlocks
}
