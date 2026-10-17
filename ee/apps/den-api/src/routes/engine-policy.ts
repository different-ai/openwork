import { getOrganizationFeatures } from "../features.js"

/** Use the registry resolver on every report, including deployment locks and kill switches. */
export async function readOrganizationEnginePolicy(organizationId: string) {
  const features = await getOrganizationFeatures(organizationId)
  return { upgrade: features.engineV2ForceUpgrade }
}
