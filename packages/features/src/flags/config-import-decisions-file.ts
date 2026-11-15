import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Config import: reuse the answers of an earlier import",
  description: "The answers given while reviewing a configuration import (what was left out, pointed at something else, matched or renamed) can be downloaded as a file and given again to a later import of the same file into the same organization, so nobody answers the same questions twice.",
  category: "administration",
  added: "2026-11-15",
  since: "2026-11",
  author: "benjaminshafii",
  docs: "docs/features/config-import-decisions-file/README.md",
  deployments: everywhere,
  default: false,
})
