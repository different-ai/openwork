/**
 * Static defaults for the marketplace seeded into every organization.
 */

export const DEFAULT_OPENWORK_MARKETPLACE_NAME = "OpenWork Marketplace"
export const DEFAULT_OPENWORK_MARKETPLACE_DESCRIPTION = "Built-in OpenWork AI capabilities available in the desktop app after sign-in."
export const DEFAULT_OPENWORK_MARKETPLACE_LOGO_URL = "/openwork-mark.svg"

export type DefaultMarketplacePluginEntry = {
  name: string
  description: string
}

/**
 * Earlier Den builds seeded a starter "Anthropic-Compatible Plugins" marketplace
 * holding these plugins as a name and description only, with no skills,
 * connectors, or commands. They read as real plugins that did nothing, so Den
 * no longer seeds them and retires any copy that is still an untouched,
 * empty placeholder. Imported or filled-in plugins with these names are kept.
 */
export const RETIRED_STARTER_MARKETPLACE_NAME = "Anthropic-Compatible Plugins"
export const RETIRED_STARTER_MARKETPLACE_DESCRIPTION = "Starter marketplace for Claude/Anthropic-compatible plugin repos. Example source: https://github.com/anthropics/knowledge-work-plugins."
export const RETIRED_STARTER_MARKETPLACE_LOGO_URL = "https://cdn.simpleicons.org/anthropic"
export const RETIRED_STARTER_PLUGIN_NAMES = [
  "Productivity",
  "Enterprise Search",
  "Sales",
  "Customer Support",
  "Product Management",
  "Marketing",
  "Legal",
  "Finance",
  "Data",
  "Engineering",
  "Design",
  "Operations",
  "Human Resources",
  "PDF Viewer",
] as const
