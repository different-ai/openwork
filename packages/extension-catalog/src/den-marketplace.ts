import { openWorkExtensionManifestCatalogV1Schema } from "@openwork/extension-contracts"
import { BUILT_IN_OPENWORK_EXTENSION_MANIFESTS } from "./catalog.js"

/**
 * Deliberate distribution policy, not a second catalog. Voice historically was
 * not seeded into Den and remains app-only until that product change is reviewed.
 */
export const DEN_MARKETPLACE_OPENWORK_EXTENSION_IDS = [
  "openwork-browser",
  "computer-use",
  "openai-image-gen",
  "google-workspace",
  "ollama",
] as const

const CONTRIBUTION_TYPES_BY_ID: Readonly<Record<(typeof DEN_MARKETPLACE_OPENWORK_EXTENSION_IDS)[number], readonly string[]>> = {
  "openwork-browser": ["settings-panel", "session-side-panel", "composer-prompt"],
  "computer-use": ["setup-instructions", "composer-prompt"],
  "openai-image-gen": ["settings-panel", "composer-prompt"],
  "google-workspace": ["settings-panel", "composer-prompt"],
  ollama: ["settings-panel", "composer-prompt"],
}

const SETUP_INSTRUCTIONS_OVERRIDES: Readonly<Partial<Record<(typeof DEN_MARKETPLACE_OPENWORK_EXTENSION_IDS)[number], string>>> = {
  "computer-use": "Computer Use is Mac only. Grant Accessibility and Screen Recording permissions, then connect the local MCP server in this workspace.",
}

/**
 * Preserves the existing Den public manifest payload while deriving every field
 * from the canonical six-item catalog. Compatibility-only omissions are explicit.
 */
export const DEN_MARKETPLACE_OPENWORK_EXTENSION_MANIFESTS = openWorkExtensionManifestCatalogV1Schema.parse(
  DEN_MARKETPLACE_OPENWORK_EXTENSION_IDS.map((id) => {
    const manifest = BUILT_IN_OPENWORK_EXTENSION_MANIFESTS.find((candidate) => candidate.id === id)
    if (!manifest) throw new Error(`Missing built-in OpenWork extension manifest: ${id}`)

    const { preview: _preview, setup, ...rest } = manifest
    const contributionTypes = CONTRIBUTION_TYPES_BY_ID[id]
    return {
      ...rest,
      setup: setup ? { instructions: SETUP_INSTRUCTIONS_OVERRIDES[id] ?? setup.instructions } : undefined,
      contributions: (manifest.contributions ?? []).filter((contribution) => (
        contributionTypes.includes(contribution.type)
      )),
    }
  }),
)

export function denMarketplaceOpenWorkExtensionManifestById(id: string) {
  return DEN_MARKETPLACE_OPENWORK_EXTENSION_MANIFESTS.find((manifest) => manifest.id === id) ?? null
}
