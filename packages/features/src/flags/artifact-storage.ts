import { defineFeature } from "@openwork/features/define"

export default defineFeature({
  label: "Artifacts that save data",
  description: "An artifact can keep its own saved data, so it works as an intake form, tracker or approval queue: what people add stays there for everyone the artifact is shared with, or privately per person. Organization admins can export it.",
  category: "experience",
  added: "2026-11-26",
  since: "2026-11",
  author: "benjaminshafii",
  docs: "docs/features/artifact-storage/README.md",
  deployments: ["cloud"],
  default: false,
})
