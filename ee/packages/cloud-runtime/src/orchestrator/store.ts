import type { SandboxRef, SandboxState } from "@openwork/sandbox"

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
  getWorkerImageVersion(workerId: string): Promise<string | null>
}

export type RuntimeInstanceInspection = {
  state: SandboxState
}
