import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Den: grey sidebar, white pages",
  description: "The Den dashboard shows its sidebar on a light grey band and every page on white, like the admin dashboard pictured on the website, instead of a white sidebar beside lightly tinted pages. Only colours change: navigation, page layouts and every control stay where they are. Turning it off restores the earlier colours at once.",
  category: "experience",
  added: "2026-11-11",
  since: "2026-11",
  author: "benjaminshafii",
  docs: "docs/features/den-grey-sidebar/README.md",
  deployments: everywhere,
  default: false,
})
