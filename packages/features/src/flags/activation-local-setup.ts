import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Get set up: count what works on this device",
  description: "The Get set up checklist also checks off a model provider and a connection that work on the person's own device, without setting them up again in OpenWork, and inviting a teammate becomes optional while they are the only person in the organization, so someone working alone can finish setup. Turning it off restores the earlier checklist at once; nothing is lost.",
  category: "experience",
  added: "2026-11-13",
  since: "2026-11",
  author: "benjaminshafii",
  docs: "docs/features/activation-local-setup/README.md",
  deployments: everywhere,
  default: false,
})
