type CatalogControl = { kind: string; name: string; effect?: string }

type CatalogTarget = { controls: readonly CatalogControl[]; hostedRollout?: readonly string[] }

type CatalogGap = { kind: string; targets: readonly string[]; flags?: readonly string[] }

/** The part of a capability (packages/managed-deployments/src/capabilities.ts) that the preview check reads. */
export type CapabilityCatalogEntry = {
  id: string
  targets: Readonly<Record<string, CatalogTarget>>
  gaps: readonly CatalogGap[]
}

export type PreviewRegistryFacts = {
  previewKeys: readonly string[]
  selfHostedKeys: readonly string[]
  retiredKeys: readonly string[]
}

function named(key: string, capability: string, facts: PreviewRegistryFacts): string | null {
  if (facts.previewKeys.includes(key)) return null
  if (facts.retiredKeys.includes(key)) return `Capability "${capability}" still names "${key}", which is retired: it shipped or was cut. Remove it from the capability catalog.`
  return `Capability "${capability}" names "${key}", which is not a preview flag. Remove it from the capability catalog or declare the preview.`
}

/**
 * Every way the capability catalog depends on preview flags that it must not. A capability works once its
 * infrastructure is installed: it may not need a preview without a recorded gap, or keep naming a retired one.
 */
export function capabilityPreviewProblems(catalog: readonly CapabilityCatalogEntry[], facts: PreviewRegistryFacts): string[] {
  const problems: string[] = []
  for (const capability of catalog) {
    for (const [target, recorded] of Object.entries(capability.targets)) {
      for (const control of recorded.controls) {
        if (control.kind !== "rollout-flag") continue
        const stale = named(control.name, capability.id, facts)
        if (stale) {
          problems.push(stale)
          continue
        }
        const gap = capability.gaps.find((entry) => entry.kind === "rollout_flag" && entry.targets.includes(target) && entry.flags?.includes(control.name))
        if (!gap) {
          problems.push(`Capability "${capability.id}" depends on preview flag "${control.name}" on ${target} without a recorded gap. A capability works once its infrastructure is installed: ship the preview, remove the dependency, or record a rollout_flag gap that names it.`)
        }
      }
      for (const key of recorded.hostedRollout ?? []) {
        const stale = named(key, capability.id, facts)
        if (stale) problems.push(stale)
        else if (facts.selfHostedKeys.includes(key)) {
          problems.push(`Capability "${capability.id}" lists "${key}" as a hosted rollout on ${target}, but that preview also exists in a customer's deployment. Record it as a rollout-flag control and a gap, or make the preview cloud only.`)
        }
      }
    }
    for (const gap of capability.gaps) {
      for (const key of gap.flags ?? []) {
        const stale = named(key, capability.id, facts)
        if (stale) problems.push(stale)
      }
    }
  }
  return [...new Set(problems)]
}
