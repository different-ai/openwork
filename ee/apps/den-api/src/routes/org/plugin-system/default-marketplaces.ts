export const DEFAULT_OPENWORK_MARKETPLACE_NAME = "OpenWork Marketplace"
export const DEFAULT_OPENWORK_MARKETPLACE_DESCRIPTION = "Built-in OpenWork AI capabilities available in the desktop app after sign-in."
export const DEFAULT_OPENWORK_MARKETPLACE_LOGO_URL = "/openwork-mark.svg"

export type DefaultMarketplacePluginEntry = {
  name: string
  description: string
}

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

export const RETIRED_DEFAULT_OPENWORK_PLUGINS: readonly DefaultMarketplacePluginEntry[] = [
  {
    name: "Computer Use",
    description: "Mac only: control Mac apps through semantic accessibility refs, screenshots, background-safe clicks, keyboard input, and strict mode.",
  },
  {
    name: "OpenWork Browser",
    description: "Automate the built-in browser panel that stays visible inside OpenWork.",
  },
  {
    name: "OpenAI Image Gen",
    description: "Generate image artifacts with gpt-image-2.",
  },
  {
    name: "Ollama",
    description: "Local model provider at http://localhost:11434.",
  },
]
