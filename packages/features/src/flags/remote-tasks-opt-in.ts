import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Desktop: other devices reach a computer only after its owner allows it",
  description: "A signed-in computer takes nothing from its owner's other devices, Workbot or agents until the owner allows it in Desktop Settings > Devices: no task can be started there and no session reached. Off, a computer whose owner has not chosen keeps taking tasks started remotely, as before. In both cases the owner can turn a computer off, and organization owners can turn remote access off for everyone on Manage > Computers.",
  category: "computerUse",
  added: "2026-11-11",
  since: "2026-11",
  author: "benjaminshafii",
  docs: "docs/features/remote-tasks-opt-in/README.md",
  deployments: everywhere,
  default: false,
})
