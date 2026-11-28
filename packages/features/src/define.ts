/**
 * What a preview flag declaration looks like. Every preview is declared in
 * ./previews.ts and collected by ./registry.ts.
 *
 * A preview flag gates unfinished work. It has an owner and a day it expires:
 * by then the work ships (the key moves to ./retired.ts and its checks are
 * removed) or is cut. Permanent settings are not previews: what a deployment
 * can do is a capability, and what an organization chooses is an org setting.
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

type Day = `${number}-${number}-${number}`

export type PreviewDefinition = {
  label: string
  description: string
  category: FeatureCategory
  added: Day
  owner: string
  expiresOn: Day
  docs?: `docs/${string}.md`
  deployments: readonly FeatureDeployment[]
  default: boolean
  outcomes?: true
}

/** The registry's entries are previews; the rest of the code still calls them features. */
export type FeatureDefinition = PreviewDefinition

/** Declares one preview flag. The export name in ./previews.ts is its key. */
export function definePreview<const T extends PreviewDefinition>(preview: T): T {
  return preview
}

export const everywhere = ["cloud", "self_hosted"] as const
