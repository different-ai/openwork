import { defineFeature, everywhere } from "@openwork/features/define"

export default defineFeature({
  label: "Desktop: sessions started from a session nest under it",
  description: "Side chats and sessions the agent starts are listed under the session they came from in the sidebar, with a way back to it. A session the agent started reports to that session when it finishes, and selected text in a reply can start a side chat.",
  category: "experience",
  added: "2026-11-16",
  since: "2026-11",
  author: "reachjalil",
  docs: "docs/features/session-tree/README.md",
  deployments: everywhere,
  default: false,
})
