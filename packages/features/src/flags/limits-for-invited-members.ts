import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Spend limits for invited people",
  description: "Admins can assign a spend limit to someone who has not accepted their invitation yet, and it applies from their first request. A configuration import assigns limits to the people it invites in the same run, instead of asking for a second import once they have joined.",
  category: "billing",
  added: "2026-11-15",
  since: "2026-11",
  author: "benjaminshafii",
  docs: "docs/features/limits-for-invited-members/README.md",
  deployments: everywhere,
  default: false,
})
