import assert from "node:assert/strict"
import { test } from "node:test"
import { capabilityPreviewProblems, type CapabilityCatalogEntry, type PreviewRegistryFacts } from "@openwork/features/capability-check"

const facts: PreviewRegistryFacts = {
  previewKeys: ["computerPreview", "hostedOnlyPreview"],
  selfHostedKeys: ["computerPreview"],
  retiredKeys: ["shippedPreview"],
}

function computers(change: Partial<CapabilityCatalogEntry> = {}): CapabilityCatalogEntry {
  return {
    id: "cloudComputers",
    targets: {
      helm: { controls: [{ kind: "runner-env", name: "HEADLESS_COMPUTER" }] },
      "managed-aws": { controls: [{ kind: "installer-input", name: "target.assistants.computerProvider" }], hostedRollout: ["hostedOnlyPreview"] },
    },
    gaps: [],
    ...change,
  }
}

const needsPreview = { kind: "rollout-flag", name: "computerPreview", effect: "required" }

test("a capability that needs no preview passes", () => {
  assert.deepEqual(capabilityPreviewProblems([computers()], facts), [])
})

test("a capability cannot depend on a preview without a recorded gap", () => {
  const silent = computers({ targets: { helm: { controls: [needsPreview] } } })
  const problems = capabilityPreviewProblems([silent], facts)
  assert.equal(problems.length, 1)
  assert.match(problems[0] ?? "", /"cloudComputers" depends on preview flag "computerPreview" on helm without a recorded gap/)

  const recorded = computers({ targets: { helm: { controls: [needsPreview] } }, gaps: [{ kind: "rollout_flag", targets: ["helm"], flags: ["computerPreview"] }] })
  assert.deepEqual(capabilityPreviewProblems([recorded], facts), [])

  const otherTarget = computers({ targets: { helm: { controls: [needsPreview] } }, gaps: [{ kind: "rollout_flag", targets: ["managed-aws"], flags: ["computerPreview"] }] })
  assert.equal(capabilityPreviewProblems([otherTarget], facts).length, 1, "a gap for another target does not cover this one")
})

test("a capability cannot keep naming a preview that shipped or was cut", () => {
  const stale = computers({
    targets: { helm: { controls: [{ kind: "rollout-flag", name: "shippedPreview", effect: "required" }] } },
    gaps: [{ kind: "rollout_flag", targets: ["helm"], flags: ["shippedPreview"] }],
  })
  assert.deepEqual(capabilityPreviewProblems([stale], facts), [
    'Capability "cloudComputers" still names "shippedPreview", which is retired: it shipped or was cut. Remove it from the capability catalog.',
  ])
  const unknown = computers({ gaps: [{ kind: "rollout_flag", targets: ["helm"], flags: ["neverDeclared"] }] })
  assert.match(capabilityPreviewProblems([unknown], facts).join("\n"), /names "neverDeclared", which is not a preview flag/)
})

test("a hosted rollout has to be a preview that cannot exist in a customer's deployment", () => {
  const customerStep = computers({ targets: { "managed-aws": { controls: [], hostedRollout: ["computerPreview"] } } })
  assert.match(capabilityPreviewProblems([customerStep], facts).join("\n"), /lists "computerPreview" as a hosted rollout on managed-aws, but that preview also exists in a customer's deployment/)
  const retired = computers({ targets: { "managed-aws": { controls: [], hostedRollout: ["shippedPreview"] } } })
  assert.match(capabilityPreviewProblems([retired], facts).join("\n"), /still names "shippedPreview", which is retired/)
})
