import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Settings: Capabilities",
  description: "Workspace admins see, for Workbot, the Slack assistant, Automations, the AI Gateway and cloud computers, whether each is installed on this deployment and which members may use it. Deployment pages list what each managed deployment has installed. Turning it off removes the page and the list; nothing else changes.",
  category: "administration",
  added: "2026-11-24",
  since: "2026-11",
  author: "benjaminshafii",
  docs: "docs/features/deployment-capabilities-view/README.md",
  deployments: everywhere,
  default: false,
})
