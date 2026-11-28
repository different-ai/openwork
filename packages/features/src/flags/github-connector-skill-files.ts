import { defineFeature } from "@openwork/features/define"

export default defineFeature({
  label: "Supporting files in GitHub-connected skills",
  description: "Keep text files that ship with skills synced from connected GitHub repositories.",
  category: "connect",
  added: "2026-11-27",
  since: "2026-11",
  author: "MaxBer",
  docs: "docs/features/github-connector-skill-files/README.md",
  deployments: ["cloud", "self_hosted"],
  default: false,
})
