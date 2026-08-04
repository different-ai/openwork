import type { AutomationRepository } from "./ports.js"

export * from "./engine-testing.js"

export async function verifyAutomationRepositoryConformance(
  repository: AutomationRepository,
): Promise<string[]> {
  const checked: string[] = []
  const definition = {
    name: "Conformance Automation",
    instructions: "Return the word ready.",
    schedule: { kind: "daily" as const, timezone: "UTC", hour: 9, minute: 0 },
    model: { providerId: "provider_conformance", modelId: "model_conformance" },
  }
  const created = await repository.create({
    organizationId: "org_conformance",
    ownerMemberId: "member_conformance",
    definition,
    now: 1_000,
  })
  if (created.automation.state !== "active") throw new Error("creation must be active")
  checked.push("transactional active creation")

  const fetched = await repository.get({
    organizationId: created.automation.organizationId,
    ownerMemberId: created.automation.ownerMemberId,
    automationId: created.automation.id,
  })
  if (fetched?.revision.id !== created.revision.id) throw new Error("created revision was not durable")
  checked.push("durable initial revision")

  const isolated = await repository.get({
    organizationId: "org_other",
    ownerMemberId: created.automation.ownerMemberId,
    automationId: created.automation.id,
  })
  if (isolated !== null) throw new Error("organization isolation failed")
  checked.push("organization isolation")

  const updated = await repository.update({
    organizationId: created.automation.organizationId,
    ownerMemberId: created.automation.ownerMemberId,
    automationId: created.automation.id,
    changes: { instructions: "Return the word updated." },
    now: 2_000,
  })
  if (updated.revision.version !== created.revision.version + 1) throw new Error("revision version did not increase")
  if (updated.revision.id === created.revision.id) throw new Error("revision was mutated in place")
  checked.push("immutable revisions")

  const firstClaim = await repository.claim({
    automation: updated.automation,
    revision: updated.revision,
    trigger: "scheduled",
    scheduledFor: updated.automation.nextDueAt,
    leaseOwner: "replica_a",
    leaseMs: 30_000,
    now: 3_000,
  })
  const secondClaim = await repository.claim({
    automation: updated.automation,
    revision: updated.revision,
    trigger: "recovery",
    scheduledFor: updated.automation.nextDueAt,
    leaseOwner: "replica_b",
    leaseMs: 30_000,
    now: 3_000,
  })
  if (firstClaim.kind !== "claimed" || secondClaim.kind === "claimed") {
    throw new Error("one occurrence was claimed by multiple replicas")
  }
  checked.push("scheduled and recovery claim deduplication")
  return checked
}
