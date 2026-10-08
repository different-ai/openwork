import type { FaqEntry } from "./faq";

export const MIGRATION_GUIDE_URL = "https://openworklabs.com/docs/start-here/migrate-from-claude-cowork";

// The one action on the migration page. The agent guide it points to lives in
// packages/openwork-bootstrap/migrate.md and is served at /migrate.md.
export const MIGRATION_PROMPT =
  "Follow https://openworklabs.com/migrate.md to move my Claude plugins and skills to OpenWork.";

export const migrationMoves = [
  {
    title: "Cowork and Claude Code plugins",
    body: "Plugins you added from a GitHub marketplace, such as Anthropic's knowledge-work-plugins, are imported into your OpenWork organization. Their skills work right away."
  },
  {
    title: "Claude skills you wrote",
    body: "Your own SKILL.md skills become private OpenWork skills that only you can use until you share them."
  },
  {
    title: "Connectors and MCP servers",
    body: "Slack, Notion, HubSpot and the other connectors a plugin suggests are added as optional. Each person connects the services they use."
  },
  {
    title: "Changes later",
    body: "Run the same prompt again to pick up plugin updates and edits to your skills. Nothing is duplicated."
  }
];

export const migrationStays = [
  "Conversation history and saved credentials",
  "Plugins that are not in a public GitHub repository",
  "Scheduled tasks, which you recreate and run once by hand"
];

export const migrationSteps = [
  {
    title: "Finds what you use",
    body: "Reads the marketplaces you added in Claude Cowork or Claude Code and the skills you wrote. Nothing leaves your computer yet.",
    command: "openwork-bootstrap migrate scan"
  },
  {
    title: "Shows you the plan",
    body: "Lists every plugin with its skills and connectors, and asks which ones you actually use.",
    command: "openwork-bootstrap migrate plan"
  },
  {
    title: "Moves what you choose",
    body: "Imports those plugins and your skills into OpenWork, then tells you what is left, such as connecting Gmail.",
    command: "openwork-bootstrap migrate apply"
  }
];

export const migrationFaq: FaqEntry[] = [
  {
    question: "Can I keep my Claude Cowork plugins in OpenWork?",
    answer:
      "Yes. Plugins from public GitHub marketplaces, including Anthropic's knowledge-work-plugins for Cowork, import into your OpenWork organization with their skills. Paste the migration prompt into Claude Code or run openwork-bootstrap migrate."
  },
  {
    question: "Do Claude skills (SKILL.md) work in OpenWork?",
    answer:
      "Yes. OpenWork uses the same SKILL.md format as Claude Cowork and Claude Code. Skills you wrote in Cowork move as private skills; skills inside plugins move with their plugin."
  },
  {
    question: "What happens to connectors like Slack, Gmail, and Google Calendar?",
    answer:
      "Connectors a plugin suggests are added as optional, so skills work before anything is connected. Each person connects the services they use in OpenWork. Gmail and Google Calendar use OpenWork's Google Workspace connection."
  },
  {
    question: "Can I keep using Claude models after switching from Cowork?",
    answer:
      "Yes. Add an Anthropic API key, or let your organization provide Claude centrally. OpenWork also runs 50+ other providers and local models, so you are not locked into one vendor."
  },
  {
    question: "What does not transfer from Claude Cowork?",
    answer:
      "Conversation history, saved credentials, and scheduled tasks do not move. Plugins that are not in a public GitHub repository need to be added by hand."
  },
  {
    question: "Can I run the migration again later?",
    answer:
      "Yes. Running it again updates plugins and skills that changed and leaves everything else as it is, so nothing is duplicated."
  }
];
