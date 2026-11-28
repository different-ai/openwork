import { defineFeature } from "@openwork/features/define"

export default defineFeature({
  label: "Artifact share links",
  description: "Copy a link to an artifact that teammates who have access can open in a browser after signing in.",
  category: "experience",
  added: "2026-11-27",
  since: "2026-11",
  author: "benjaminshafii",
  docs: "docs/features/artifact-share-links/README.md",
  deployments: ["cloud", "self_hosted"],
  default: false,
})
