import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Connector catalog recovery",
  description: "People can tell when connectors are loading and retry if the catalog cannot load.",
  category: "connect",
  added: "2026-11-24",
  since: "2026-11",
  author: "whoElseButUmar",
  docs: "docs/features/connector-catalog-recovery/README.md",
  deployments: everywhere,
  default: false,
})
