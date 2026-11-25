import { defineFeature } from "@openwork/features/define"

export default defineFeature({
  label: "Search from the browser address bar",
  description: "Enter a web search or a website address in the desktop browser.",
  category: "experience",
  added: "2026-11-25",
  since: "2026-11",
  author: "reachjalil",
  docs: "docs/features/browser-address-search/README.md",
  deployments: ["cloud", "self_hosted"],
  default: false,
})
