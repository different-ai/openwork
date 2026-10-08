import { createHash } from "node:crypto"
import { SandboxError, isSandboxError } from "./errors.js"
import type { SandboxBlocks } from "./blocks.js"
import type { ProviderTimeout, SandboxHandle, SandboxProvider, SandboxSpec } from "./provider.js"

export const SCOPE_LABEL = "openwork.sandbox.scope"

export function sandboxName(scope: string, job: string, key: string): string {
  if (!scope.trim() || !job.trim() || !key.trim()) throw new Error("scope, job and key must not be empty")
  const prefix = (`${scope}-${job}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 30).replace(/-$/, "") || "sandbox")
  const hash = createHash("sha256").update(JSON.stringify([scope, job, key])).digest("hex").slice(0, 24)
  return `${prefix}-${hash}`
}

/** Returns only the requested, verified blocks. No speculative combinations or silent fallbacks. */
export function withBlocks<K extends keyof SandboxBlocks>(provider: SandboxProvider, keys: readonly K[], job = "job"): Required<Pick<SandboxBlocks, K>> {
  const blocks = provider.blocks ?? {}
  for (const key of keys) {
    if (!blocks[key]) throw new SandboxError({ providerId: provider.id, code: "invalid_state", retryable: false, message: `${job} requires ${key}; ${provider.id} does not provide it` })
  }
  // Runtime validation above proves all requested properties are present.
  return blocks as Required<Pick<SandboxBlocks, K>>
}

/** Adopt by stable identity; only a proven create conflict permits lookup/retry. */
export async function ensure(provider: SandboxProvider, spec: SandboxSpec, opts: ProviderTimeout): Promise<SandboxHandle> {
  const existing = await provider.find({ idempotencyKey: spec.idempotencyKey, labels: spec.labels })
  if (existing && existing.state !== "missing") return existing
  try {
    return await provider.create(spec, opts)
  } catch (error) {
    if (!isSandboxError(error) || error.code !== "conflict") throw error
    const adopted = await provider.find({ idempotencyKey: spec.idempotencyKey, labels: spec.labels })
    if (!adopted) throw error // caller may retry ensure after visibility settles; never repeat create blindly
    return adopted
  }
}

/** Ensure a running instance before a command. Never retries an executed command. */
export async function ensureRunning(provider: SandboxProvider, spec: SandboxSpec, opts: ProviderTimeout): Promise<SandboxHandle> {
  let handle = await ensure(provider, spec, opts)
  handle = await provider.inspect(handle)
  if (handle.state === "missing") handle = await provider.create(spec, opts)
  if (handle.state === "stopped" || handle.state === "archived") {
    await provider.start(handle, opts)
    handle = await provider.inspect(handle)
  }
  if (handle.state !== "running") throw new SandboxError({ providerId: provider.id, code: "invalid_state", message: `Sandbox is ${handle.state}, not running` })
  return handle
}

/** Explicit destructive operation: exact scope only, enumerated before any deletion. */
export async function destroyScope(provider: SandboxProvider, scope: string, opts: ProviderTimeout): Promise<{ deleted: SandboxHandle[]; failed: Array<{ handle: SandboxHandle; error: unknown }> }> {
  if (!scope.trim()) throw new Error("scope must not be empty")
  const candidates = await provider.list({ labels: { [SCOPE_LABEL]: scope } })
  const deleted: SandboxHandle[] = []
  const failed: Array<{ handle: SandboxHandle; error: unknown }> = []
  for (const handle of candidates) {
    try {
      await provider.destroy(handle, opts)
      deleted.push(handle)
    } catch (error) {
      if (isSandboxError(error) && error.code === "not_found") deleted.push(handle)
      else failed.push({ handle, error })
    }
  }
  // This destroys compute only. Persistent volumes/snapshots have separate owners.
  return { deleted, failed }
}
