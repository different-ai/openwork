import type { RuntimeInstanceRecord, RuntimeInstanceStore } from "../orchestrator/store"

export type InMemoryRuntimeInstanceStore = RuntimeInstanceStore & {
  records: Map<string, RuntimeInstanceRecord>
  imageVersions: Map<string, string | null>
  upserts: RuntimeInstanceRecord[]
}

export function createInMemoryRuntimeInstanceStore(): InMemoryRuntimeInstanceStore {
  const records = new Map<string, RuntimeInstanceRecord>()
  const imageVersions = new Map<string, string | null>()
  const upserts: RuntimeInstanceRecord[] = []
  return {
    records,
    imageVersions,
    upserts,
    async get(workerId) {
      return records.get(workerId) ?? null
    },
    async upsert(record) {
      upserts.push(record)
      records.set(record.workerId, record)
    },
    async updateEndpoint(workerId, update) {
      const existing = records.get(workerId)
      if (!existing) throw new Error(`no runtime record for ${workerId}`)
      records.set(workerId, { ...existing, ...update })
    },
    async getWorkerImageVersion(workerId) {
      return imageVersions.get(workerId) ?? null
    },
  }
}
