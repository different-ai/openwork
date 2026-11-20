import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Workbot: Your agent says when it stops reading a source",
  description: "When a source Your agent read in the last week is no longer on for a member (an admin turned it off, or it became the member's own choice and they never chose), the agent tells them once in their Workbot DM, and My bot shows a check naming the source it stopped reading. Without it the agent keeps checking what is left and only looks quiet.",
  category: "workbot",
  added: "2026-11-18",
  since: "2026-11",
  author: "reachjalil",
  docs: "docs/features/workbot-agent-stopped-sources/README.md",
  deployments: everywhere,
  default: false,
})
