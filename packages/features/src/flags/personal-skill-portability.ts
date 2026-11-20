import { defineFeature } from "@openwork/features/define"

export default defineFeature({
  label: "Personal skill portability",
  description: "Members can export their own private skills and import them as private copies in My Library.",
  category: "experience",
  added: "2026-11-19",
  since: "2026-11",
  author: "benjaminshafii",
  docs: "docs/features/personal-skill-portability/README.md",
  deployments: ["cloud", "self_hosted"],
  default: false,
})
