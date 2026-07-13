import type {
  EnablementCondition,
  EnablementConditionType,
  OpenWorkExtensionContribution,
  OpenWorkExtensionContributionType,
  OpenWorkExtensionManifest,
  OpenWorkExtensionResource,
  OpenWorkExtensionResourceType,
} from "./schemas.js"

type OptionalManifest = OpenWorkExtensionManifest | null | undefined

export function extensionContribution(
  manifest: OptionalManifest,
  type: OpenWorkExtensionContributionType,
): OpenWorkExtensionContribution | undefined {
  return manifest?.contributions?.find((contribution) => contribution.type === type)
}

export function extensionResource(
  manifest: OptionalManifest,
  type: OpenWorkExtensionResourceType,
): OpenWorkExtensionResource | undefined {
  return manifest?.resources.find((resource) => resource.type === type)
}

export function extensionEnablementCondition(
  manifest: OptionalManifest,
  type: EnablementConditionType,
  ref?: string,
): EnablementCondition | undefined {
  return manifest?.enablement?.find((condition) =>
    condition.type === type && (ref === undefined || condition.ref === ref))
}

export function extensionManifestById(
  manifests: readonly OpenWorkExtensionManifest[],
  id: string,
): OpenWorkExtensionManifest | undefined {
  return manifests.find((manifest) => manifest.id === id)
}

export function isTrustedBuiltInExtension(manifest: OptionalManifest): boolean {
  return manifest?.source.origin === "builtin" && manifest.source.trusted
}
