/**
 * Static defaults for the marketplaces seeded into every organization.
 *
 * The starter plugin catalog mirrors the first-party plugins published in
 * https://github.com/anthropics/knowledge-work-plugins (.claude-plugin/marketplace.json).
 * Seeding these entries keeps the starter marketplace useful before an org
 * connects the repository; when the GitHub connector later imports the repo,
 * discovery reuses these plugin rows by name and fills in their content.
 */

export const DEFAULT_OPENWORK_MARKETPLACE_NAME = "OpenWork Marketplace"
export const DEFAULT_OPENWORK_MARKETPLACE_DESCRIPTION = "Built-in OpenWork AI capabilities available in the desktop app after sign-in."
export const DEFAULT_OPENWORK_MARKETPLACE_LOGO_URL = "/openwork-mark.svg"

export const DEFAULT_ANTHROPIC_MARKETPLACE_NAME = "Anthropic-Compatible Plugins"
export const DEFAULT_ANTHROPIC_MARKETPLACE_DESCRIPTION = "Starter marketplace for Claude/Anthropic-compatible plugin repos. Example source: https://github.com/anthropics/knowledge-work-plugins."
export const DEFAULT_ANTHROPIC_MARKETPLACE_LOGO_URL = "https://cdn.simpleicons.org/anthropic"

export type DefaultMarketplacePluginEntry = {
  name: string
  description: string
}

export const DEFAULT_ANTHROPIC_STARTER_PLUGINS: DefaultMarketplacePluginEntry[] = [
  {
    name: "Productivity",
    description: "Manage tasks, plan your day, and build up memory of important context about your work. Syncs with your calendar, email, and chat to keep everything organized and on track.",
  },
  {
    name: "Enterprise Search",
    description: "Search across all of your company's tools in one place. Find anything across email, chat, documents, and wikis without switching between apps.",
  },
  {
    name: "Sales",
    description: "Prospect, craft outreach, and build deal strategy faster. Prep for calls, manage your pipeline, and write personalized messaging that moves deals forward.",
  },
  {
    name: "Customer Support",
    description: "Triage tickets, draft responses, escalate issues, and build your knowledge base. Research customer context and turn resolved issues into self-service content.",
  },
  {
    name: "Product Management",
    description: "Write feature specs, plan roadmaps, and synthesize user research faster. Keep stakeholders updated and stay ahead of the competitive landscape.",
  },
  {
    name: "Marketing",
    description: "Create content, plan campaigns, and analyze performance across marketing channels. Maintain brand voice consistency, track competitors, and report on what's working.",
  },
  {
    name: "Legal",
    description: "Speed up contract review, NDA triage, and compliance workflows for in-house legal teams. Draft legal briefs, organize precedent research, and manage institutional knowledge.",
  },
  {
    name: "Finance",
    description: "Streamline finance and accounting workflows, from journal entries and reconciliation to financial statements and variance analysis. Speed up audit prep, month-end close, and keeping your books clean.",
  },
  {
    name: "Data",
    description: "Write SQL, explore datasets, and generate insights faster. Build visualizations and dashboards, and turn raw data into clear stories for stakeholders.",
  },
  {
    name: "Engineering",
    description: "Streamline engineering workflows — standups, code review, architecture decisions, incident response, and technical documentation. Works with your existing tools or standalone.",
  },
  {
    name: "Design",
    description: "Accelerate design workflows — critique, design system management, UX writing, accessibility audits, research synthesis, and dev handoff. From exploration to pixel-perfect specs.",
  },
  {
    name: "Operations",
    description: "Optimize business operations — vendor management, process documentation, change management, capacity planning, and compliance tracking. Keep your organization running efficiently.",
  },
  {
    name: "Human Resources",
    description: "Streamline people operations — recruiting, onboarding, performance reviews, compensation analysis, and policy guidance. Maintain compliance and keep your team running smoothly.",
  },
  {
    name: "PDF Viewer",
    description: "View, annotate, and sign PDFs in a live interactive viewer. Mark up contracts, fill forms with visual feedback, stamp approvals, and place signatures — then download the annotated copy.",
  },
]
