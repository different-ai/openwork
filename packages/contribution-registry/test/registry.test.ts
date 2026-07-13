import assert from "node:assert/strict"
import test from "node:test"

import {
  CONTRIBUTION_CONTRACT_VERSION,
  createContributionRegistry,
  type ContributionDescriptor,
} from "../src/index.js"

interface TestDescriptor extends ContributionDescriptor {
  readonly kind: "test"
  readonly label?: string
  readonly metadata?: Readonly<Record<string, unknown>>
}

interface TestHost {
  readonly prefix: string
}

interface TestRuntime {
  readonly value: string
  readonly dispose?: () => void
}

const descriptor = (
  id: string,
  overrides: Partial<TestDescriptor> = {},
): TestDescriptor => ({
  id,
  kind: "test",
  contractVersion: CONTRIBUTION_CONTRACT_VERSION,
  provenance: {
    packageName: `@openwork/${id}`,
    packageVersion: "1.0.0",
    source: `test/${id}`,
  },
  ...overrides,
})

const ready = (value: string) => ({
  status: "ready" as const,
  create: (host: TestHost): TestRuntime => ({ value: `${host.prefix}${value}` }),
})

test("freezes a descriptor-only snapshot in dependency-aware deterministic order", () => {
  const registry = createContributionRegistry<TestDescriptor, TestHost, TestRuntime>()
  const dependent = descriptor("feature/dependent", {
    order: -100,
    requires: ["feature/base"],
  })

  const registrationResults = registry.registerAll([
    {
      descriptor: descriptor("feature/zeta", { order: 10 }),
      binding: ready("zeta"),
    },
    { descriptor: dependent, binding: ready("dependent") },
    {
      descriptor: descriptor("feature/alpha", { order: 10 }),
      binding: ready("alpha"),
    },
    {
      descriptor: descriptor("feature/base", { order: 100 }),
      binding: ready("base"),
    },
  ])

  assert.equal(Object.isFrozen(registrationResults), true)
  assert.deepEqual(
    registrationResults.map((registration) => registration.status),
    ["registered", "registered", "registered", "registered"],
  )

  const result = registry.freeze()
  assert.equal(result.status, "ready")
  assert.deepEqual(
    result.snapshot.entries.map((entry) => entry.descriptor.id),
    ["feature/alpha", "feature/zeta", "feature/base", "feature/dependent"],
  )
  assert.deepEqual(result.snapshot.entries.at(-1)?.descriptor.provenance, {
    packageName: "@openwork/feature/dependent",
    packageVersion: "1.0.0",
    source: "test/feature/dependent",
  })
  assert.equal("binding" in result.snapshot.entries[0]!, false)
  assert.equal("create" in result.snapshot.entries[0]!, false)
  assert.equal(Object.isFrozen(result.snapshot), true)
  assert.equal(Object.isFrozen(result.snapshot.entries), true)
  assert.equal(Object.isFrozen(result.snapshot.entries.at(-1)!.descriptor), true)
  assert.equal(Object.isFrozen(result.snapshot.entries.at(-1)!.descriptor.requires), true)
  assert.strictEqual(registry.freeze(), result)
})

test("rejects duplicate and unsupported registrations and retains diagnostics", () => {
  const registry = createContributionRegistry<TestDescriptor, TestHost, TestRuntime>({
    supportedContractVersions: [1],
  })

  assert.equal(registry.register(descriptor("feature/one"), ready("one")).status, "registered")
  const duplicate = registry.register(descriptor("feature/one"), ready("replacement"))
  const unsupported = registry.register(
    descriptor("feature/future", { contractVersion: 2 }),
    ready("future"),
  )

  assert.equal(duplicate.status, "rejected")
  assert.equal(
    duplicate.status === "rejected" ? duplicate.diagnostic.code : undefined,
    "duplicate-id",
  )
  assert.equal(unsupported.status, "rejected")
  assert.equal(
    unsupported.status === "rejected" ? unsupported.diagnostic.code : undefined,
    "unsupported-contract-version",
  )

  const frozen = registry.freeze()
  assert.equal(frozen.status, "invalid")
  assert.deepEqual(
    frozen.snapshot.diagnostics.map((issue) => issue.code),
    ["duplicate-id", "unsupported-contract-version"],
  )
  assert.equal(Object.isFrozen(registry.diagnostics()), true)
})

test("defensively clones and deeply freezes custom serializable metadata", () => {
  const registry = createContributionRegistry<TestDescriptor, TestHost, TestRuntime>()
  const metadata = {
    tags: ["stable"],
    nested: { enabled: true },
  }
  registry.register(
    descriptor("feature/metadata", { metadata }),
    ready("metadata"),
  )

  metadata.tags.push("mutated-after-registration")
  metadata.nested.enabled = false

  const frozen = registry.freeze()
  assert.equal(frozen.status, "ready")
  const snapshotMetadata = frozen.snapshot.entries[0]?.descriptor.metadata as {
    readonly tags: readonly string[]
    readonly nested: Readonly<{ enabled: boolean }>
  }
  assert.deepEqual(snapshotMetadata, {
    tags: ["stable"],
    nested: { enabled: true },
  })
  assert.equal(Object.isFrozen(snapshotMetadata), true)
  assert.equal(Object.isFrozen(snapshotMetadata.tags), true)
  assert.equal(Object.isFrozen(snapshotMetadata.nested), true)
})

test("rejects non-serializable custom metadata as structured diagnostics", () => {
  const registry = createContributionRegistry<TestDescriptor, TestHost, TestRuntime>()
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  const sparse = new Array<string>(2)
  sparse[1] = "present"

  const results = [
    registry.register(
      descriptor("feature/function", { metadata: { factory: () => "runtime" } }),
      ready("function"),
    ),
    registry.register(
      descriptor("feature/cyclic", { metadata: cyclic }),
      ready("cyclic"),
    ),
    registry.register(
      descriptor("feature/date", { metadata: { createdAt: new Date(0) } }),
      ready("date"),
    ),
    registry.register(
      descriptor("feature/non-finite", { metadata: { score: Number.NaN } }),
      ready("non-finite"),
    ),
    registry.register(
      descriptor("feature/sparse", { metadata: { values: sparse } }),
      ready("sparse"),
    ),
  ]

  assert.deepEqual(
    results.map((result) =>
      result.status === "rejected" ? result.diagnostic.code : undefined,
    ),
    [
      "invalid-descriptor",
      "invalid-descriptor",
      "invalid-descriptor",
      "invalid-descriptor",
      "invalid-descriptor",
    ],
  )
  assert.match(
    results[0]?.status === "rejected" ? results[0].diagnostic.message : "",
    /\$\.metadata\.factory: function values are not serializable/u,
  )
  assert.match(
    results[1]?.status === "rejected" ? results[1].diagnostic.message : "",
    /\$\.metadata\.self: cyclic references are not serializable/u,
  )
  assert.equal(registry.snapshot().entries.length, 0)
  assert.equal(registry.freeze().status, "invalid")
})

test("reports missing requirements and precise dependency cycles", () => {
  const missing = createContributionRegistry<TestDescriptor, TestHost, TestRuntime>()
  missing.register(
    descriptor("feature/dependent", { requires: ["feature/missing"] }),
    ready("dependent"),
  )
  const missingResult = missing.freeze()
  assert.equal(missingResult.status, "invalid")
  assert.deepEqual(missingResult.snapshot.diagnostics, [
    {
      severity: "error",
      code: "missing-requirement",
      message:
        'Contribution "feature/dependent" requires missing contribution "feature/missing".',
      contributionId: "feature/dependent",
      relatedIds: ["feature/missing"],
    },
  ])

  const cyclic = createContributionRegistry<TestDescriptor, TestHost, TestRuntime>()
  cyclic.register(descriptor("feature/a", { requires: ["feature/b"] }), ready("a"))
  cyclic.register(descriptor("feature/b", { requires: ["feature/a"] }), ready("b"))
  cyclic.register(descriptor("feature/after", { requires: ["feature/a"] }), ready("after"))

  const cyclicResult = cyclic.freeze()
  assert.equal(cyclicResult.status, "invalid")
  const cycleIssue = cyclicResult.snapshot.diagnostics.find(
    (issue) => issue.code === "dependency-cycle",
  )
  assert.deepEqual(cycleIssue?.relatedIds, ["feature/a", "feature/b"])
  assert.deepEqual(
    cyclicResult.snapshot.entries.map((entry) => entry.descriptor.id),
    ["feature/a", "feature/after", "feature/b"],
  )
})

test("keeps disabled and unavailable contributions visible without executing", () => {
  const registry = createContributionRegistry<TestDescriptor, TestHost, TestRuntime>()
  let executions = 0
  registry.register(descriptor("feature/disabled"), {
    status: "disabled",
    reason: "Disabled by workspace policy",
  })
  registry.register(descriptor("feature/unavailable"), {
    status: "unavailable",
    reason: "Requires a desktop runtime",
  })
  registry.register(descriptor("feature/ready"), {
    status: "ready",
    create: () => {
      executions += 1
      return { value: "ready" }
    },
  })
  registry.freeze()

  assert.deepEqual(registry.lookup("feature/disabled"), {
    status: "found",
    descriptor: descriptor("feature/disabled"),
    availability: { status: "disabled", reason: "Disabled by workspace policy" },
  })
  assert.deepEqual(registry.construct("feature/disabled", { prefix: "" }), {
    status: "disabled",
    descriptor: descriptor("feature/disabled"),
    reason: "Disabled by workspace policy",
  })
  assert.deepEqual(registry.construct("feature/unavailable", { prefix: "" }), {
    status: "unavailable",
    descriptor: descriptor("feature/unavailable"),
    reason: "Requires a desktop runtime",
  })
  assert.equal(executions, 0)
})

test("isolates construction failures and continues constructing later entries", () => {
  const registry = createContributionRegistry<TestDescriptor, TestHost, TestRuntime>()
  const failure = new Error("factory failed")
  registry.register(descriptor("feature/a-fails"), {
    status: "ready",
    create: () => {
      throw failure
    },
  })
  registry.register(descriptor("feature/b-works"), ready("works"))
  registry.freeze()

  const results = registry.constructAll({ prefix: "host:" })
  assert.equal(results.length, 2)
  assert.equal(results[0]?.status, "failed")
  assert.strictEqual(results[0]?.status === "failed" ? results[0].cause : undefined, failure)
  assert.deepEqual(results[1], {
    status: "constructed",
    descriptor: descriptor("feature/b-works"),
    value: { value: "host:works" },
  })
  assert.equal(Object.isFrozen(results), true)
})

test("returns discriminated unknown and not-ready results without throwing", () => {
  const registry = createContributionRegistry<TestDescriptor, TestHost, TestRuntime>()
  registry.register(descriptor("feature/known"), ready("known"))

  assert.deepEqual(registry.lookup("feature/unknown"), {
    status: "unknown",
    id: "feature/unknown",
  })
  assert.deepEqual(registry.construct("feature/known", { prefix: "" }), {
    status: "registry-not-ready",
    id: "feature/known",
    diagnostics: [],
  })

  registry.freeze()
  assert.deepEqual(registry.construct("feature/unknown", { prefix: "" }), {
    status: "unknown",
    id: "feature/unknown",
  })
})

test("rejects registration after freeze without mutating the frozen snapshot", () => {
  const registry = createContributionRegistry<TestDescriptor, TestHost, TestRuntime>()
  registry.register(descriptor("feature/known"), ready("known"))
  const frozen = registry.freeze()
  const rejected = registry.register(descriptor("feature/late"), ready("late"))

  assert.equal(registry.isFrozen, true)
  assert.equal(rejected.status, "rejected")
  assert.equal(
    rejected.status === "rejected" ? rejected.diagnostic.code : undefined,
    "registration-frozen",
  )
  assert.strictEqual(registry.snapshot(), frozen.snapshot)
  assert.deepEqual(registry.diagnostics(), [])
  assert.deepEqual(registry.lookup("feature/late"), {
    status: "unknown",
    id: "feature/late",
  })
})

test("leaves runtime disposal ownership with the host", () => {
  const registry = createContributionRegistry<TestDescriptor, TestHost, TestRuntime>()
  let disposals = 0
  registry.register(descriptor("feature/lifecycle"), {
    status: "ready",
    create: () => ({
      value: "runtime",
      dispose: () => {
        disposals += 1
      },
    }),
  })
  registry.freeze()

  const result = registry.construct("feature/lifecycle", { prefix: "" })
  assert.equal(result.status, "constructed")
  registry.snapshot()
  registry.freeze()
  assert.equal(disposals, 0)

  if (result.status === "constructed") result.value.dispose?.()
  assert.equal(disposals, 1)
})

test("validates descriptor and binding invariants before accepting entries", () => {
  const registry = createContributionRegistry<TestDescriptor, TestHost, TestRuntime>()
  const invalidId = registry.register(descriptor("bad id"), ready("bad"))
  const repeatedRequirement = registry.register(
    descriptor("feature/repeated", {
      requires: ["feature/base", "feature/base"],
    }),
    ready("bad"),
  )
  const invalidReason = registry.register(descriptor("feature/disabled"), {
    status: "disabled",
    reason: "",
  })

  assert.deepEqual(
    [invalidId, repeatedRequirement, invalidReason].map((result) =>
      result.status === "rejected" ? result.diagnostic.code : undefined,
    ),
    ["invalid-descriptor", "invalid-descriptor", "invalid-binding"],
  )
  assert.equal(registry.snapshot().entries.length, 0)
})

test("rejects an invalid supported-version configuration", () => {
  assert.throws(
    () =>
      createContributionRegistry<TestDescriptor, TestHost, TestRuntime>({
        supportedContractVersions: [],
      }),
    TypeError,
  )
})
