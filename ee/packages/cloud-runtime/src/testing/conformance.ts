import assert from "node:assert/strict"
import { isRuntimeProviderError } from "../contract/errors"
import type { SandboxProvider, SandboxSpec } from "../contract/provider"

export type ConformanceCase = {
  name: string
  run: () => Promise<void>
}

export type ConformanceOptions = {
  /** Per-operation budget handed to the provider. */
  timeoutMs?: number
  /** A volume name the provider may create and erase during the run. */
  volumeName?: string
  /** A shell command that exits 0 quickly on this provider (default `true`). */
  trivialCommand?: string
}

type ProviderFactory = () => Promise<SandboxProvider> | SandboxProvider

function specFor(provider: SandboxProvider, key: string, extra: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    workerId: `worker-${key}`,
    idempotencyKey: `conformance-${key}`,
    image: provider.currentImage(),
    labels: { "openwork.den.conformance": key },
    env: { DEN_CONFORMANCE: "1" },
    storage: [],
    exposePorts: [8787],
    ...extra,
  }
}

async function expectProviderError(
  operation: () => Promise<unknown>,
  code: string,
  providerId: string,
) {
  let caught: unknown = null
  try {
    await operation()
  } catch (error) {
    caught = error
  }
  assert.ok(caught !== null, `expected the provider to throw ${code}`)
  assert.ok(isRuntimeProviderError(caught), `expected a RuntimeProviderError, got ${String(caught)}`)
  assert.equal(caught.code, code)
  assert.equal(caught.providerId, providerId)
}

/**
 * Behaviour every `SandboxProvider` must exhibit before Den can select it.
 * Runner-agnostic: iterate the cases with `test(name, run)` in any framework.
 */
export function sandboxProviderConformanceCases(
  factory: ProviderFactory,
  options: ConformanceOptions = {},
): ConformanceCase[] {
  const timeout = { timeoutMs: options.timeoutMs ?? 30_000 }
  const volumeName = options.volumeName ?? "openwork-conformance"
  const trivialCommand = options.trivialCommand ?? "true"

  return [
    {
      name: "describes capabilities consistent with its behaviour",
      async run() {
        const provider = await factory()
        const capabilities = provider.describe()
        assert.equal(typeof provider.id, "string")
        assert.ok(provider.id.length > 0)
        assert.equal(typeof capabilities.stopResume, "boolean")
        assert.equal(typeof capabilities.exec, "boolean")
        assert.ok(["signed-expiring", "stable", "den-tunnel"].includes(capabilities.endpointKind))
        const image = provider.currentImage()
        if (image !== null) {
          assert.ok(image.id.length > 0)
          assert.ok(image.version.length > 0)
        }
      },
    },
    {
      name: "creates a running instance and finds it again by idempotency key",
      async run() {
        const provider = await factory()
        const spec = specFor(provider, `create-${Date.now()}`)
        const created = await provider.create(spec, timeout)
        try {
          assert.equal(created.ref.providerId, provider.id)
          assert.ok(Object.keys(created.ref.ref).length > 0, "ref must carry provider identity")
          assert.equal(created.state, "running")
          const found = await provider.find({ idempotencyKey: spec.idempotencyKey })
          assert.ok(found, "find by idempotency key must return the created instance")
          assert.deepEqual(found.ref, created.ref)
          const byLabel = await provider.find({ labels: spec.labels })
          assert.ok(byLabel)
          assert.deepEqual(byLabel.ref, created.ref)
          const fetched = await provider.get(created.ref)
          assert.ok(fetched)
          assert.deepEqual(fetched.ref, created.ref)
        } finally {
          await provider.destroy(created, timeout)
        }
      },
    },
    {
      name: "refuses to create a second instance for the same idempotency key",
      async run() {
        const provider = await factory()
        const spec = specFor(provider, `idempotent-${Date.now()}`)
        const created = await provider.create(spec, timeout)
        try {
          await expectProviderError(() => provider.create(spec, timeout), "conflict", provider.id)
          const found = await provider.find({ idempotencyKey: spec.idempotencyKey })
          assert.ok(found)
          assert.deepEqual(found.ref, created.ref)
        } finally {
          await provider.destroy(created, timeout)
        }
      },
    },
    {
      name: "returns null for a missing instance instead of throwing",
      async run() {
        const provider = await factory()
        const missing = await provider.get({ providerId: provider.id, ref: { sandboxId: `missing-${Date.now()}` } })
        assert.equal(missing, null)
        const notFound = await provider.find({ idempotencyKey: `never-created-${Date.now()}` })
        assert.equal(notFound, null)
      },
    },
    {
      name: "stops and resumes when it claims stopResume, and reports the state through inspect",
      async run() {
        const provider = await factory()
        if (!provider.describe().stopResume) return
        const created = await provider.create(specFor(provider, `resume-${Date.now()}`), timeout)
        try {
          await provider.stop(created, timeout)
          const stopped = await provider.inspect(created)
          assert.equal(stopped.state, "stopped")
          assert.ok(stopped.observedAt >= created.observedAt)
          await provider.start(stopped, timeout)
          const running = await provider.inspect(stopped)
          assert.equal(running.state, "running")
        } finally {
          await provider.destroy(created, timeout)
        }
      },
    },
    {
      name: "destroy makes the instance missing and later operations fail with not_found",
      async run() {
        const provider = await factory()
        const created = await provider.create(specFor(provider, `destroy-${Date.now()}`), timeout)
        await provider.destroy(created, timeout)
        assert.equal(await provider.get(created.ref), null)
        const inspected = await provider.inspect(created)
        assert.equal(inspected.state, "missing")
        await expectProviderError(() => provider.start(created, timeout), "not_found", provider.id)
      },
    },
    {
      name: "exec reports exit codes and logs",
      async run() {
        const provider = await factory()
        if (!provider.describe().exec) return
        const created = await provider.create(specFor(provider, `exec-${Date.now()}`), timeout)
        try {
          const exec = await provider.exec(created, { command: trivialCommand, detach: false, timeoutMs: timeout.timeoutMs })
          assert.ok(exec.id.length > 0)
          const exitCode = await exec.exitCode()
          assert.equal(exitCode, 0)
          const logs = await exec.logs()
          assert.equal(typeof logs.stdout, "string")
          assert.equal(typeof logs.stderr, "string")
        } finally {
          await provider.destroy(created, timeout)
        }
      },
    },
    {
      name: "endpoint kind and expiry match the declared capability",
      async run() {
        const provider = await factory()
        const created = await provider.create(specFor(provider, `endpoint-${Date.now()}`), timeout)
        try {
          const endpoint = await provider.endpoint(created, 8787, { ttlSeconds: 600 })
          assert.equal(endpoint.kind, provider.describe().endpointKind)
          assert.ok(endpoint.url.startsWith("http"), `endpoint url must be absolute, got ${endpoint.url}`)
          if (endpoint.kind === "stable") {
            assert.equal(endpoint.expiresAt, null)
          } else {
            assert.ok(endpoint.expiresAt instanceof Date, "expiring endpoints must carry expiresAt")
            assert.ok(endpoint.expiresAt.getTime() > Date.now())
          }
        } finally {
          await provider.destroy(created, timeout)
        }
      },
    },
    {
      name: "storage volumes are idempotent and subpath erasure is scoped",
      async run() {
        const provider = await factory()
        if (!provider.describe().persistentStorage) return
        const first = await provider.storage.ensureVolume(volumeName, timeout)
        const second = await provider.storage.ensureVolume(volumeName, timeout)
        assert.equal(first.providerId, provider.id)
        assert.deepEqual(second, first)
        await provider.storage.eraseSubpaths(first, [`workers/conformance-${Date.now()}`], timeout)
        if (provider.storage.exists) {
          assert.equal(await provider.storage.exists(first, `workers/never-written-${Date.now()}`, timeout), false)
        }
      },
    },
  ]
}
