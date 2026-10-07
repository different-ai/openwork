import type { SandboxProvider } from "./provider.js"

export type SandboxOperationEvent = { providerId: string; operation: string; durationMs: number; outcome: "ok" | "error" }
/** No commands, env, file contents, tokens or endpoints are emitted. Observer failures cannot change a result. */
export function instrument(provider: SandboxProvider, observe: (event: SandboxOperationEvent) => void, now = () => performance.now()): SandboxProvider {
  function method<A extends unknown[], R>(name: string, fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
    return async (...args) => {
      const started = now()
      let outcome: "ok" | "error" = "error"
      try {
        const result = await fn(...args)
        outcome = "ok"
        return result
      } finally {
        try { observe({ providerId: provider.id, operation: name, durationMs: now() - started, outcome }) } catch { /* observers are best-effort */ }
      }
    }
  }
  const b = provider.blocks
  return {
    ...provider,
    id: provider.id,
    describe: () => provider.describe(),
    currentImage: () => provider.currentImage(),
    create: method("create", (...args) => provider.create(...args)),
    find: method("find", (...args) => provider.find(...args)),
    list: method("list", (...args) => provider.list(...args)),
    get: method("get", (...args) => provider.get(...args)),
    inspect: method("inspect", (...args) => provider.inspect(...args)),
    start: method("start", (...args) => provider.start(...args)),
    stop: method("stop", (...args) => provider.stop(...args)),
    destroy: method("destroy", (...args) => provider.destroy(...args)),
    exec: method("exec", (...args) => provider.exec(...args)),
    endpoint: method("endpoint", (...args) => provider.endpoint(...args)),
    storage: {
      ensureVolume: method("storage.ensureVolume", (...args) => provider.storage.ensureVolume(...args)),
      eraseSubpaths: method("storage.eraseSubpaths", (...args) => provider.storage.eraseSubpaths(...args)),
      ...(provider.storage.exists ? { exists: method("storage.exists", provider.storage.exists.bind(provider.storage)) } : {}),
    },
    blocks: {
      ...(b?.run ? { run: method("run", b.run) } : {}),
      ...(b?.files ? { files: {
        read: method("files.read", b.files.read.bind(b.files)),
        write: method("files.write", b.files.write.bind(b.files)),
        stat: method("files.stat", b.files.stat.bind(b.files)),
      } } : {}),
      ...(b?.pause ? { pause: method("pause", b.pause) } : {}),
      ...(b?.snapshots ? { snapshots: { create: method("snapshots.create", b.snapshots.create.bind(b.snapshots)), destroy: method("snapshots.destroy", b.snapshots.destroy.bind(b.snapshots)) } } : {}),
    },
  }
}
