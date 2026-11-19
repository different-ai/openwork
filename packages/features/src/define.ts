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
  /** Short name shown to platform admins and operators. */
  label: string
  /** One sentence: what a person gets, in words they see in the product. */
  description: string
  /** Group the feature is listed under in /admin. */
  category: FeatureCategory
  /** Day the flag was first added to this registry, e.g. "2026-10-26". Never changes. */
  added: `${number}-${number}-${number}`
  /** Year and month the entry was added or last changed, e.g. "2026-10". */
  since: `${number}-${number}`
  /**
   * GitHub handle of the person who owns the feature: who to ask what it does,
   * whether it is safe to turn on, and when the flag can go. Shown in /admin.
   */
  author: string
  /**
   * Repo path of the internal doc that explains the feature, e.g.
   * "docs/features/new-thing/README.md". Internal docs live in the repo's
   * docs/ folder, not the published site in packages/docs. A visual feature
   * shows at least one screenshot (stored next to the doc); any other feature
   * says what changes, for whom, how to try it and what turning it off does.
   * Linked from /admin. Required for new features (`pnpm features:check`).
   */
  docs?: `docs/${string}.md`
  /** Products it exists on. Leave one out on purpose, e.g. ["cloud"] for cloud-only. */
  deployments: readonly FeatureDeployment[]
  /** On or off for everyone on a fresh deployment: false for new work, true once everyone has it. */
  default: boolean
  /**
   * The switch is part of the product (e.g. platform admins turn Connect off for
   * one organization), not a temporary rollout. Rollouts are deleted once done;
   * `pnpm features:check` asks for a decision six months after `since`.
   */
  permanent?: boolean
  /**
   * The feature works in the background (a schedule, a calendar, an agent's
   * checks, messages sent by runs), so no request shows whether it ran or
   * worked. /admin › Features reads its outcomes from the store that already
   * holds them: den-api registers exactly one reader for each feature that
   * sets this (ee/apps/den-api/src/feature-outcomes/readers.ts), and its
   * typecheck fails without one.
   */
  outcomes?: true
}

/** Declares one feature. The file name is the key in kebab-case: flags/new-thing.ts declares `newThing`. */
export function defineFeature<const T extends FeatureDefinition>(feature: T): T {
  return feature
}

export const everywhere = ["cloud", "self_hosted"] as const
