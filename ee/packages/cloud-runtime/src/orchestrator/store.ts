import type { SandboxRef, SandboxState } from "../contract/provider"

/**
 * Den's durable view of one worker's Cloud instance. Provider-neutral: the
 * host is identified by `sandbox` (opaque) and the storage it was attached to.
 */
export type RuntimeInstanceRecord = {
  workerId: string
  sandbox: SandboxRef
  storage: {
    workspaceVolumeId: string
    dataVolumeId: string
  }
  /** Endpoint to reach the instance and the moment it stops being safe to use. */
  endpointUrl: string
  endpointExpiresAt: Date
  region: string | null
}

export type RuntimeEndpointUpdate = {
  endpointUrl: string
  endpointExpiresAt: Date
  region: string | null
}

export interface RuntimeInstanceStore {
  get(workerId: string): Promise<RuntimeInstanceRecord | null>
  upsert(record: RuntimeInstanceRecord): Promise<void>
  updateEndpoint(workerId: string, update: RuntimeEndpointUpdate): Promise<void>
  /** The image version the worker last booted, or `null` before its first healthy boot. */
  getWorkerImageVersion(workerId: string): Promise<string | null>
}

export type RuntimeInstanceInspection = {
  state: SandboxState
}
