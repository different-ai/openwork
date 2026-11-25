/**
 * What a feature declaration looks like. Each feature lives in its own file
 * under ./flags and is collected by ./registry.ts.
 */

export type FeatureDeployment = "cloud" | "self_hosted"

/**
 * Groups for /admin, in the order they are shown. Pick the one a platform
 * admin would look under; add a group only when none fits.
 */
export const FEATURE_CATEGORIES = {
  billing: { label: "Plans, billing and usage", description: "Plans, checkout, grants and what people see when an allowance runs out." },
  models: { label: "Models and providers", description: "Which models people can pick and how providers stay in sync." },
  connect: { label: "Connect and integrations", description: "Connected services, their tools and MCP servers." },
  computerUse: { label: "Computer use and browser", description: "Agents using apps, browsers and remote computers." },
  workbot: { label: "Workbot", description: "Documents, the workspace assistant and navigation in Workbot." },
  automations: { label: "Automations", description: "Scheduled work and where it shows up." },
  administration: { label: "Administration and security", description: "Organization controls, deployments and how Den stores sign-ins." },
  experience: { label: "Onboarding and everyday use", description: "Getting set up, signing in, dictation, imports and artifacts." },
} as const satisfies Record<string, { label: string; description: string }>

export type FeatureCategory = keyof typeof FEATURE_CATEGORIES

export type FeatureDefinition = {
  label: string
  description: string
  category: FeatureCategory
  added: `${number}-${number}-${number}`
  since: `${number}-${number}`
  author: string
  docs?: `docs/${string}.md`
  deployments: readonly FeatureDeployment[]
  default: boolean
  permanent?: boolean
  outcomes?: true
}

/** Declares one feature. The file name is the key in kebab-case: flags/new-thing.ts declares `newThing`. */
export function defineFeature<const T extends FeatureDefinition>(feature: T): T {
  return feature
}

export const everywhere = ["cloud", "self_hosted"] as const
